import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoworkCostCalculator } from "../components/cowork-cost-calculator";
import { cumulativeCosts, usageProfiles } from "../lib/cowork-cost";
import { modelPrices } from "../lib/model-prices";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const sonnet = modelPrices.find((model) => model.id === "claude-sonnet-5");
const deepseek = modelPrices.find((model) => model.id === "deepseek-v4-pro");

describe("cost calculator results", () => {
  test("shows the same-model and open-model comparisons side by side", () => {
    if (!sonnet || !deepseek) throw new Error("expected default models");
    const costs = cumulativeCosts({
      users: 50,
      usage: usageProfiles.typical.usage,
      tier: "team",
      model: sonnet,
      openModel: deepseek,
      months: 36
    });
    const openModel = costs.openModel;
    if (!openModel) throw new Error("expected open model line");
    const page = text(renderToStaticMarkup(createElement(CoworkCostCalculator)));

    expect(page).toContain(`Same model on both (${sonnet.label})`);
    expect(page).toContain(`You keep ${dollars.format(costs.claude.total - costs.openwork.total)}`);
    expect(page).toContain(`Claude Team ${dollars.format(costs.claude.total)} vs OpenWork ${dollars.format(costs.openwork.total)}`);
    expect(page).toContain(`OpenWork with ${deepseek.label}`);
    // The open-model card is a total against Claude, not an increment on the first card.
    expect(page).toContain(`You keep ${dollars.format(costs.claude.total - openModel.total)}`);
    expect(page).toContain(`Claude Team ${dollars.format(costs.claude.total)} vs OpenWork ${dollars.format(openModel.total)}`);
    expect(page).not.toContain("more with");

    expect(page).toContain("Claude model (both sides)");
    expect(page).toContain("Compare an open model on OpenWork");
    // Chart lines name vendor and model.
    expect(page).toContain("Claude Team · Sonnet 5 (Premium seats)");
    expect(page).toContain(`OpenWork · ${sonnet.label}`);
    expect(page).toContain(`OpenWork · ${deepseek.label}`);
    expect(page).toContain("Claude on 3P · Sonnet 5");
  });

  test("says plainly when Claude costs less on the 3P variant", () => {
    if (!sonnet) throw new Error("expected default model");
    const costs = cumulativeCosts({
      users: 500,
      usage: usageProfiles.typical.usage,
      tier: "enterprise",
      model: sonnet,
      months: 36
    });
    const page = text(renderToStaticMarkup(createElement(CoworkCostCalculator, { defaultUsers: 500, defaultTier: "enterprise", claudeSide: "3p" })));
    const delta = costs.claude3p.total - costs.openwork.total;
    expect(delta).toBeLessThan(0);
    expect(page).toContain(`Claude costs ${dollars.format(-delta)} less`);
    expect(page).toContain(`Claude on 3P ${dollars.format(costs.claude3p.total)} vs OpenWork ${dollars.format(costs.openwork.total)}`);
  });
});
