/**
 * Telegram's command menu: the "/" button and autocomplete. Telegram only
 * shows commands a bot registers with setMyCommands (at most 100 per
 * list), and this bot has over 100, so the menu holds the everyday ones;
 * every other command still works when typed, and /help lists them all.
 * Registered at startup, so the menu always matches the code.
 */

const GROUP = [
  ["help", "What this DAO can do here"],
  ["dao", "This chat's DAO: treasury, rules, model"],
  ["wallet", "Your wallet address"],
  ["balance", "Your tokens and stake"],
  ["stake", "Stake tokens to vote: /stake <amount>"],
  ["unstake", "Withdraw staked tokens: /unstake <amount>"],
  ["propose", "Propose a treasury payment"],
  ["proposeaction", "Propose any listed action"],
  ["listactions", "Actions a proposal can take"],
  ["perps", "Perps: positions, prices, trade proposals"],
  ["proposals", "Recent proposals"],
  ["proposal", "One proposal: /proposal <id>"],
  ["vote", "Vote: /vote <id> for|against|abstain"],
  ["queue", "Queue a passed proposal: /queue <id>"],
  ["execute", "Run a queued proposal: /execute <id>"],
  ["cancel", "Cancel your proposal: /cancel <id>"],
  ["challenge", "Optimistic: challenge a proposal"],
  ["support", "Conviction: back a proposal"],
  ["confirm", "Board: confirm a proposal"],
  ["council", "Delegate/Sortition: the council"],
  ["treasury", "The treasury's address and balance"],
  ["send", "Send tokens or native coin"],
  ["tip", "Creator: hand out starting tokens"],
  ["feeds", "Price feed names for oracle proposals"],
  ["network", "Which network this chat's DAO is on"],
  ["createdao", "Admins: create a DAO for this chat"],
  ["createboarddao", "Admins: create a signer multisig DAO"],
  ["register", "Admins: link an existing DAO"],
];

const PRIVATE = [
  ["start", "Start the bot"],
  ["help", "What the bot can do"],
  ["wallet", "Your wallet address"],
];

/** Sets the menu for group chats and private chats. Never throws. */
export async function registerTelegramMenu(api) {
  const toCommands = (list) => list.map(([command, description]) => ({ command, description }));
  try {
    await api.setMyCommands(toCommands(GROUP), { scope: { type: "all_group_chats" } });
    await api.setMyCommands(toCommands(PRIVATE), { scope: { type: "all_private_chats" } });
    await api.setMyCommands(toCommands(GROUP), { scope: { type: "default" } });
  } catch (err) {
    console.error("Couldn't set Telegram's command menu:", err.message);
  }
}
