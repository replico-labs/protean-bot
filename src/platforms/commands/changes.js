import { getAddress, isAddress, parseUnits, formatUnits } from "viem";
import { getChatModel, getChatGuardWrapper, registerGuardWrapper, registerConverter, getChatConverter } from "../../db.js";
import { publicClient, writeWithGasBuffer } from "../../config.js";
import { getAdapter } from "../../governance/index.js";
import { takeModelOptions, checkModelOptions, proposeForModel, proposalNextStep } from "../../modelProposal.js";
import { buildTokenChange, buildCouncilOn, buildCouncilOff, buildCouncilReplace, parseRate, daoState, ChangeError, CONVERTER_ABI, GUARD_ABI } from "../../governanceChanges.js";
import { short } from "../../format.js";
import { UserError, reply, requireDao, userClient, proposalReply } from "../helpers.js";

/**
 * Token changes, the stake converter and the security council, for EVM
 * DAOs (src/governanceChanges.js builds the proposals). Solana DAOs answer
 * the same commands in src/solana/commands.js, which runs first.
 */

const ERC20 = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "lockedBalance", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];
const read = (address, abi, functionName, args = []) => publicClient.readContract({ address: getAddress(address), abi, functionName, args });

/** Proposes `actions` on the chat's DAO; name=value words are the DAO's own proposal settings (Sowellian, Decision Markets). */
async function propose(ctx, governance, model, actions, words, fallback) {
  const { options, rest } = takeModelOptions(model, words);
  checkModelOptions(model, options);
  const description = rest.join(" ") || fallback;
  const { client } = await userClient(ctx, { forceFullTopup: true });
  const { proposalId } = await proposeForModel({ model, client, governanceAddress: governance, actions, description, options });
  return proposalId;
}

const rethrow = (err) => {
  if (err instanceof ChangeError) throw new UserError(err.message);
  throw err;
};

export const CHANGE_COMMANDS = {
  settoken: {
    section: "Proposing",
    usage: "<token|new:name:symbol:supply> [rate=N:D fund=<amount>] [description]",
    description: "Propose changing this DAO's token (governance stays; optional converter for old stake)",
    options: [
      { name: "token", description: "An ERC20 address, or new:<name>:<symbol>:<supply>", required: true },
      { name: "details", description: "rate=N:D and fund=<amount> for a converter, then a description", required: false, rest: true },
    ],
    async run(ctx) {
      const governance = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const [spec, ...rest] = ctx.args;
      if (!spec) {
        throw new UserError(
          [
            `Usage: \`${ctx.cmd("settoken")} <token|new:name:symbol:supply> [rate=N:D fund=<amount>] [description]\``,
            "",
            "Moves the DAO to another token without changing its governance: new proposals vote with stake in the new token; open ones keep the old.",
            "`rate=` and `fund=` open a converter members swap their old stake through (N new tokens per D old), funded from the Treasury.",
            "",
            `Example: \`${ctx.cmd("settoken")} new:Acme:ACME:1000000 rate=1 fund=500000 Move to ACME\``,
          ].join("\n")
        );
      }
      const own = rest.filter((w) => /^(rate|fund)=/i.test(w));
      const words = rest.filter((w) => !/^(rate|fund)=/i.test(w));
      const opt = Object.fromEntries(own.map((w) => [w.slice(0, w.indexOf("=")).toLowerCase(), w.slice(w.indexOf("=") + 1)]));
      const plan = await (async () => {
        const rate = parseRate(opt.rate);
        if (opt.fund && !rate) throw new ChangeError("fund= goes with rate=.");
        // The new token's decimals: 18 for one the factory makes; read for an existing one.
        const decimals = /^new:/i.test(spec) ? 18 : await read(spec, ERC20, "decimals").catch(() => 18);
        const fundRaw = opt.fund ? parseUnits(opt.fund, Number(decimals)) : 0n;
        return buildTokenChange({ model, governance, tokenSpec: spec, rate, fundRaw });
      })().catch(rethrow);
      const proposalId = await propose(ctx, governance, model, plan.actions, words, "Change this DAO's token");
      if (plan.converter) registerConverter(ctx.chatId, plan.converter, ctx.platform);
      const lines = [
        `✅ Proposal #${proposalId}: change this DAO's token to \`${plan.token}\`${plan.created ? ` (new: ${plan.created.symbol}, ${plan.created.supply} minted to the Treasury)` : ""}.`,
        `New staking contract: \`${plan.staking}\`. The governance stays the same; open proposals keep the old token.`,
        ...(plan.converter ? [`Converter: \`${plan.converter}\` - once it runs, members swap old stake with \`${ctx.cmd("convert")} <amount>\`.`] : [`Members unstake the old token and stake the new one when it runs.`]),
        ...plan.notes.map((n) => `• ${n}`),
        "",
        proposalNextStep(model, proposalId, ctx.cmd),
      ];
      return proposalReply(ctx, governance, model, proposalId, lines.join("\n"));
    },
  },

  convert: {
    section: "Your wallet",
    usage: "<amount>",
    description: "Swap your stake in the DAO's old token for stake in its new one, through its converter",
    tokenOnly: true,
    options: [{ name: "amount", description: "How much of your old stake to convert", required: true }],
    async run(ctx) {
      requireDao(ctx);
      const converter = getChatConverter(ctx.chatId, ctx.platform);
      if (!converter) throw new UserError(`This DAO has no converter. After a token change, unstake the old token and stake the new one.`);
      const c = { address: getAddress(converter), abi: CONVERTER_ABI };
      const [open, from, to, num, den] = await Promise.all([
        read(c.address, c.abi, "open").catch(() => false),
        read(c.address, c.abi, "from"),
        read(c.address, c.abi, "to"),
        read(c.address, c.abi, "rateNum"),
        read(c.address, c.abi, "rateDen"),
      ]).catch(() => [false]);
      if (!open) throw new UserError("The converter is closed (or not deployed yet - the token change proposal has to run first).");
      const decimals = Number(await read(from, ERC20, "decimals").catch(() => 18));
      if (!ctx.args[0]) throw new UserError(`Usage: \`${ctx.cmd("convert")} <amount>\``);
      const raw = parseUnits(ctx.args[0], decimals);
      const { account, client } = await userClient(ctx);
      const [held, locked] = await Promise.all([read(from, ERC20, "balanceOf", [account.address]), read(from, ERC20, "lockedBalance", [account.address]).catch(() => 0n)]);
      if (held - locked < raw) throw new UserError(`You have ${formatUnits(held - locked, decimals)} old stake free to convert.`);
      const approve = await writeWithGasBuffer(client, { address: getAddress(from), abi: ERC20, functionName: "approve", args: [c.address, raw] });
      await publicClient.waitForTransactionReceipt({ hash: approve });
      const hash = await writeWithGasBuffer(client, { ...c, functionName: "convert", args: [raw] });
      await publicClient.waitForTransactionReceipt({ hash });
      const out = (raw * num) / den;
      const toDecimals = Number(await read(await read(to, [{ type: "function", name: "underlying", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], "underlying"), ERC20, "decimals").catch(() => 18));
      return reply(`✅ Converted ${formatUnits(raw, decimals)} old stake into ${formatUnits(out, toDecimals)} staked in the new token (the old tokens went to the Treasury).`);
    },
  },

  council: {
    section: "Council",
    usage: "[on <required> <tenure-days> <signer…> | off | replace <required> <signer…>] [description]",
    description: "The security council (any model), or this model's elected or drawn council",
    options: [
      { name: "action", description: "on, off or replace (leave empty to see the council)", required: false, choices: ["on", "off", "replace"] },
      { name: "details", description: "required approvals, tenure days and signer addresses (on), signers (replace), then a description", required: false, rest: true },
    ],
    async run(ctx) {
      const governance = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const [sub, ...rest] = ctx.args;
      const word = String(sub ?? "").toLowerCase();

      if (word === "on") {
        const [requiredStr, daysStr, ...more] = rest;
        const signers = more.filter((w) => isAddress(w, { strict: false }));
        const words = more.filter((w) => !isAddress(w, { strict: false }));
        const required = Number(requiredStr);
        const days = Number(daysStr);
        if (!signers.length || !Number.isFinite(days) || days <= 0) throw new UserError(`Usage: \`${ctx.cmd("council")} on <required> <tenure-days> <signer…> [description]\` — e.g. \`2 90 0xA… 0xB… 0xC…\``);
        const plan = await buildCouncilOn({ model, governance, signers, required, tenureSeconds: Math.round(days * 86_400) }).catch(rethrow);
        const proposalId = await propose(ctx, governance, model, plan.actions, words, "Put a security council in front of the Treasury");
        // Linked now; actions route through it only once it holds the Treasury.
        registerGuardWrapper(ctx.chatId, plan.wrapper, ctx.platform);
        return proposalReply(
          ctx,
          governance,
          model,
          proposalId,
          [
            `✅ Proposal #${proposalId}: turn on a security council of ${signers.length} (${required} must confirm each Treasury action; replaceable without them after ${days} days).`,
            `Its wrapper is created at \`${plan.wrapper}\` and takes the Treasury, token and staking contract in the same execution.`,
            "",
            proposalNextStep(model, proposalId, ctx.cmd),
          ].join("\n")
        );
      }
      if (word === "off") {
        const plan = await buildCouncilOff({ model, governance }).catch(rethrow);
        const proposalId = await propose(ctx, governance, model, plan.actions, rest, "Turn the security council off");
        return proposalReply(ctx, governance, model, proposalId, [`✅ Proposal #${proposalId}: hand the Treasury, token and staking contract back from the council. After it runs the council confirms the batch (\`${ctx.cmd("confirminstruction")} <id>\`); if it refuses, replace the signers once their tenure ends, then try again.`, "", proposalNextStep(model, proposalId, ctx.cmd)].join("\n"));
      }
      if (word === "replace") {
        const [requiredStr, ...more] = rest;
        const signers = more.filter((w) => isAddress(w, { strict: false }));
        const words = more.filter((w) => !isAddress(w, { strict: false }));
        if (!signers.length) throw new UserError(`Usage: \`${ctx.cmd("council")} replace <required> <signer…> [description]\``);
        const plan = await buildCouncilReplace({ model, governance, signers, required: Number(requiredStr) }).catch(rethrow);
        const proposalId = await propose(ctx, governance, model, plan.actions, words, "Replace the security council's signers");
        const note = plan.early ? `⚠️ Their tenure ends ${new Date(plan.tenureEnd * 1000).toUTCString()}; executing before then fails.` : "Their tenure is over, so this needs no confirmation from them.";
        return proposalReply(ctx, governance, model, proposalId, [`✅ Proposal #${proposalId}: replace the security council with ${signers.length} signer(s).`, note, "", proposalNextStep(model, proposalId, ctx.cmd)].join("\n"));
      }

      // Status: the elected or drawn council (delegate, sortition), then the security council.
      const lines = [];
      const adapter = getAdapter(model);
      if (typeof adapter.getCouncil === "function") {
        const council = await adapter.getCouncil(governance);
        lines.push(`*Current council* (${council.length}):`, ...council.map((a, i) => `${i + 1}. \`${short(a)}\``));
        if (typeof adapter.electionStatusText === "function") lines.push("", (await adapter.electionStatusText(governance)).replace(/\/([a-z]+)\b/g, (m, n) => ctx.cmd(n)));
        lines.push("");
      }
      const s = await daoState(model, governance).catch(() => null);
      const wrapper = s?.wrapper ?? getChatGuardWrapper(ctx.chatId, ctx.platform);
      if (s?.wrapper) {
        const [signers, required, tenureEnd] = await Promise.all([read(wrapper, GUARD_ABI, "getSigners"), read(wrapper, GUARD_ABI, "requiredApprovals"), read(wrapper, GUARD_ABI, "tenureEnd")]);
        lines.push(
          `*Security council* (\`${short(wrapper)}\`): ${required} of ${signers.length} confirm each Treasury action`,
          ...signers.map((a) => `• \`${short(a)}\``),
          `The DAO can replace them without their confirmation from ${new Date(Number(tenureEnd) * 1000).toUTCString()}.`,
          `Turn it off: \`${ctx.cmd("council")} off\`.`
        );
      } else {
        lines.push(`No security council holds this DAO's Treasury. Turn one on: \`${ctx.cmd("council")} on <required> <tenure-days> <signer…>\`.`);
      }
      return reply(lines.join("\n"));
    },
  },
};

