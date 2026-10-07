/** One line on what a Conviction proposal may spend (BUDGET_VERSION 2). */
export function budgetLine(budget) {
  if (budget.weakensRules) return "⚠️ Changes the DAO's spending rules or hands over control - needs the conviction of spending everything.";
  return budget.text ? `May spend: ${budget.text}` : "Spends nothing from the Treasury's listed assets.";
}

/** /assets: what a Conviction DAO checks, how much each asset counts, and what the Treasury holds. */
export function assetsText(entries, cmd) {
  const lines = ["*Listed assets* - proposals must budget for these; anything else isn't checked.", ""];
  for (const a of entries) {
    const label = a.asset === "0x0000000000000000000000000000000000000000" ? a.symbol : `${a.symbol} \`${a.asset}\``;
    lines.push(`• ${label} - weight ${a.weight}, Treasury holds ${a.holding}`);
    if (a.pending) {
      const when = new Date(a.pending.effectiveAt * 1000).toUTCString();
      const what = a.pending.remove ? "removal" : `cut to ${a.pending.weight}`;
      const due = Date.now() / 1000 >= a.pending.effectiveAt;
      lines.push(`  ⏳ ${what} ${due ? `is due - \`${cmd("assets")} apply ${a.asset}\`` : `applies from ${when}`}`);
    }
  }
  lines.push(
    "",
    "A weight is the extra conviction needed to spend all of that asset; spending 10% of it adds a tenth.",
    `Change the list by proposal: \`conviction-add-asset\`, \`conviction-set-asset-weight\`, \`conviction-remove-asset\` (see \`${cmd("actioninfo")}\`). Cuts and removals need the highest conviction and wait 7 days.`
  );
  return lines.join("\n");
}
