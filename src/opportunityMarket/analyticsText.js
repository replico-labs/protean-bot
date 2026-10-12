import { formatUnits } from "viem";
import { short } from "../format.js";

/**
 * The deployer's private analytics report (summarizeBets output) as
 * Markdown, shared by Telegram's /analytics and the Discord/Slack
 * `analytics` command.
 */
export function formatMarketAnalytics(stats, decimals) {
  const amt = (v) => `*${formatUnits(v, decimals)}*`;
  const pct = (bps) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

  const perOpportunity = stats.opportunities.map((o) =>
    o.betCount === 0
      ? `#${o.id} (\`${short(o.lister)}\`): no bets yet`
      : `#${o.id} (\`${short(o.lister)}\`): ${amt(o.totalStaked)} from ${o.betCount} bet(s) by ${o.backerCount} backer(s) · ` +
        `avg ${amt(o.averageBet)} · largest ${amt(o.largestBet)} · ${pct(o.shareBps)} of all stake`
  );

  const notes = [];
  if (stats.zeroBets) notes.push(`${stats.zeroBets} bet(s) placed with too little balance were zeroed and aren't in the averages.`);
  if (stats.unmatchedBets) notes.push(`${stats.unmatchedBets} bet(s) named an opportunity that doesn't exist; they count in the totals only.`);

  return [
    "*Market analytics*",
    "",
    `Bets placed: *${stats.totalBets}* by *${stats.totalUniqueBettors}* bettor(s)`,
    `Total staked: ${amt(stats.totalStakedOverall)}`,
    `Average bet: ${stats.fundedBets ? amt(stats.averageBet) : "—"}`,
    `Average staked per bettor: ${stats.totalUniqueBettors ? amt(stats.averagePerBettor) : "—"}`,
    `Largest bet: ${stats.fundedBets ? amt(stats.largestBet) : "—"}`,
    ...(notes.length ? ["", ...notes.map((n) => `_${n}_`)] : []),
    "",
    "*Per opportunity:*",
    ...(perOpportunity.length ? perOpportunity : ["No opportunities listed yet."]),
  ].join("\n");
}
