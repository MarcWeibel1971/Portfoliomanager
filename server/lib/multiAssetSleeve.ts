/**
 * Multi-Asset-Sleeve (Obligationen, Rohstoffe, Gold, Immobilien, Krypto).
 *
 * Erweitert den bisher strikt aktienbasierten Auto-Portfolio-Vorschlag um
 * ETF-/ETP-Sleeves je nach Anlegerprofil. Die Aktien-Pipeline (Scoring,
 * Optimierung, FX-Enforcement) bleibt unverändert — dieses Modul skaliert das
 * Aktien-Sleeve auf die Profil-Quote und ergänzt feste Matrix-Gewichte für die
 * übrigen Anlageklassen (vor der Cash-Quote).
 *
 * Reine Kernlogik (`applyMultiAssetSleeve`) ist mit injizierbarem
 * `resolvePrice` testbar; `createDbPriceResolver` kapselt DB + Multi-API.
 */

import type { RiskProfile } from "./investorProfileScoring";

export type AssetClass = "bond" | "commodity" | "gold" | "realestate" | "crypto";
export type SleeveAssetKey = "equity" | AssetClass;

export interface SleeveEtf {
  ticker: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  isin?: string;
  cryptoKind?: "btc" | "sol";
}

/** Deutsche Anzeigenamen der Anlageklassen (für Notes, Prompts, UI). */
export const ASSET_CLASS_LABELS: Record<SleeveAssetKey, string> = {
  equity: "Aktien",
  bond: "Obligationen",
  commodity: "Rohstoffe",
  gold: "Gold",
  realestate: "Immobilien",
  crypto: "Krypto",
};

/**
 * Kuratierte ETF/ETP-Liste (primärer Kandidat zuerst, danach Fallbacks).
 *
 * Live-Validierung via Yahoo Finance (v8/chart, Juli 2026) — Ergebnis:
 * - bond:        AGGH.SW ✓ (4.68 EUR, iShares Core Global Agg. Bond EUR Hedged;
 *                Achtung: Yahoo-Kurs auf SIX z.T. veraltet) · AGG ✓ (97.46 USD)
 *                · CSBGC0.SW ✓ (102.68 CHF, iShares Swiss Gov Bond 7-15)
 * - commodity:   CMDY ✓ (55.07 USD, iShares Bloomberg Roll Select Commodity) · PDBC ✓ (15.78 USD)
 *                CMOD.SW entfernt: kein EODHD-EOD-Endpunkt (404); BCOM.SW entfernt (404)
 * - gold:        ZGLD.SW ✓ (985.30 CHF, Swisscanto Gold ETF) · CSGLDE.SW ✓
 *                (106.54 EUR, Yahoo-Kurs veraltet) · SGLN.L ✓ (5924 GBp)
 *                — SGLN.SW entfernt: auf Yahoo nicht auflösbar (404)
 * - realestate:  REET ✓ (27.65 USD, iShares Global REIT ETF) · VNQI ✓ (44.82 USD, Vanguard Global ex-US REIT)
 *                IWDP.L entfernt: kein EODHD-EOD-Endpunkt (404); SREAL.SW entfernt: nicht handelbar
 * - crypto btc:  ABTC.SW ✓ (14.65 CHF, 21Shares Bitcoin ETP) · VBTC.SW entfernt: kein EODHD-EOD-Endpunkt (404)
 * - crypto sol:  ASOL.SW ✓ (41.89 CHF, 21Shares Solana Staking ETP) · VSOL.SW ✓
 *                (3.51 CHF, VanEck Solana ETN)
 */
export const MULTI_ASSET_ETFS: Record<AssetClass, SleeveEtf[]> = {
  bond: [
    { ticker: "AGGH.SW", name: "iShares Core Global Aggregate Bond UCITS ETF (EUR Hedged)", assetClass: "bond", currency: "EUR" },
    { ticker: "AGG", name: "iShares Core U.S. Aggregate Bond ETF", assetClass: "bond", currency: "USD" },
    { ticker: "CSBGC0.SW", name: "iShares Swiss Domestic Government Bond 7-15 ETF", assetClass: "bond", currency: "CHF" },
  ],
  commodity: [
    { ticker: "CMDY", name: "iShares Bloomberg Roll Select Commodity Strategy ETF", assetClass: "commodity", currency: "USD" },
    { ticker: "PDBC", name: "Invesco Optimum Yield Diversified Commodity Strategy ETF", assetClass: "commodity", currency: "USD" },
  ],
  gold: [
    { ticker: "ZGLD.SW", name: "Swisscanto (CH) Gold ETF EA CHF", assetClass: "gold", currency: "CHF" },
    { ticker: "CSGLDE.SW", name: "iShares Gold EUR Hedged ETF (CH)", assetClass: "gold", currency: "EUR" },
    { ticker: "SGLN.L", name: "iShares Physical Gold ETC", assetClass: "gold", currency: "GBp" },
  ],
  realestate: [
    { ticker: "REET", name: "iShares Global REIT ETF", assetClass: "realestate", currency: "USD" },
    { ticker: "VNQI", name: "Vanguard Global ex-U.S. Real Estate ETF", assetClass: "realestate", currency: "USD" },
  ],
  crypto: [
    { ticker: "ABTC.SW", name: "21Shares Bitcoin ETP", assetClass: "crypto", currency: "CHF", cryptoKind: "btc" },
    { ticker: "ASOL.SW", name: "21Shares Solana Staking ETP", assetClass: "crypto", currency: "CHF", cryptoKind: "sol" },
    { ticker: "VSOL.SW", name: "VanEck Solana ETN", assetClass: "crypto", currency: "CHF", cryptoKind: "sol" },
  ],
};

/** Aufteilung des Krypto-Sleeves: 70 % Bitcoin / 30 % Solana. */
export const CRYPTO_BTC_SHARE = 0.7;
export const CRYPTO_SOL_SHARE = 0.3;

/** DB-Settings-Key für die admin-konfigurierbare Allokations-Matrix. */
export const MULTI_ASSET_ALLOCATION_SETTINGS_KEY = "multi_asset_allocation";

/**
 * Liest die Allokations-Matrix aus der DB (appSettings) mit Fallback auf
 * die hartcodierten MULTI_ASSET_ALLOCATION-Konstanten. Fehlertolerant.
 */
export async function getMultiAssetAllocation(): Promise<Record<RiskProfile, Record<SleeveAssetKey, number>>> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return MULTI_ASSET_ALLOCATION;
    const { appSettings } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(appSettings).where(eq(appSettings.key, MULTI_ASSET_ALLOCATION_SETTINGS_KEY)).limit(1);
    if (!rows.length || !rows[0].value) return MULTI_ASSET_ALLOCATION;
    const stored = rows[0].value as Record<string, Record<string, number>>;
    // Validate: all 4 risk profiles present, each sums to ~100
    const profiles: RiskProfile[] = ["konservativ", "ausgewogen", "wachstum", "aggressiv"];
    const keys: SleeveAssetKey[] = ["equity", "bond", "commodity", "gold", "realestate", "crypto"];
    for (const p of profiles) {
      if (!stored[p]) return MULTI_ASSET_ALLOCATION;
      const sum = keys.reduce((s, k) => s + (Number(stored[p][k]) || 0), 0);
      if (Math.abs(sum - 100) > 2) return MULTI_ASSET_ALLOCATION; // invalid — fallback
    }
    return stored as Record<RiskProfile, Record<SleeveAssetKey, number>>;
  } catch {
    return MULTI_ASSET_ALLOCATION;
  }
}

/**
 * Ziel-Quoten in % des investierten Kapitals (vor Cash-Quote), Summe je
 * Profil = 100. Ergänzt STRATEGIC_ALLOCATIONS (investorProfileScoring) um die
 * nicht-traditionellen Anlageklassen.
 */
export const MULTI_ASSET_ALLOCATION: Record<RiskProfile, Record<SleeveAssetKey, number>> = {
  konservativ: { equity: 30, bond: 50, commodity: 4, gold: 8, realestate: 8, crypto: 0 },
  ausgewogen: { equity: 55, bond: 25, commodity: 4, gold: 7, realestate: 6, crypto: 3 },
  wachstum: { equity: 70, bond: 12, commodity: 4, gold: 6, realestate: 4, crypto: 4 },
  aggressiv: { equity: 80, bond: 5, commodity: 3, gold: 4, realestate: 2, crypto: 6 },
};

/** Empfohlene Aktienquote je Profil (%). Quelle für den Abweichungs-Hinweis
 *  bei der «Nur Aktien»-Option (Client spiegelt diese Werte). */
export const STRATEGIC_EQUITY_SHARE: Record<RiskProfile, number> = {
  konservativ: MULTI_ASSET_ALLOCATION.konservativ.equity,
  ausgewogen: MULTI_ASSET_ALLOCATION.ausgewogen.equity,
  wachstum: MULTI_ASSET_ALLOCATION.wachstum.equity,
  aggressiv: MULTI_ASSET_ALLOCATION.aggressiv.equity,
};

export interface SleeveEquityInput {
  ticker: string;
  name?: string;
  /** Gewicht in % (Summe über alle Aktien ≈ 100). */
  weight: number;
  [key: string]: unknown;
}

export interface ResolvedPrice {
  price: number;
  currency: string;
  name?: string;
}

export type ResolvePriceFn = (ticker: string) => Promise<ResolvedPrice | null>;

export interface SleevePosition {
  ticker: string;
  name?: string;
  /** Gewicht in % des investierten Kapitals (vor Cash-Quote). */
  weight: number;
  assetType: "stock" | "etf";
  assetClass: SleeveAssetKey;
  price?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface MultiAssetSleeveResult {
  /** Skalierte Aktien-Positionen + ETF-/ETP-Positionen der Sleeves. */
  positions: SleevePosition[];
  /** Effektiv angewandte Allokation in % (nach etwaigen Streichungen). */
  allocation: Record<SleeveAssetKey, number>;
  notes: string[];
  /** Gesetzt bei stocksOnly=true: Hinweis auf Abweichung vom Profil-Mix. */
  deviationNote: string | null;
}

export interface ApplyMultiAssetSleeveOptions {
  equityPositions: SleeveEquityInput[];
  riskProfile: RiskProfile;
  stocksOnly: boolean;
  resolvePrice: ResolvePriceFn;
  /** Max. Fremdwährungsanteil in % (0–100). Default: kein Limit. */
  maxFxPct?: number;
  /** Referenzwährung des Anlegers (z.B. 'CHF'). Default: 'CHF'. */
  referenceCurrency?: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Hinweistext, wenn der Nutzer «Nur Aktien» wählt, obwohl das Profil einen
 *  Multi-Asset-Mix empfiehlt. */
export function buildDeviationNote(riskProfile: RiskProfile): string {
  const equityPct = STRATEGIC_EQUITY_SHARE[riskProfile];
  return (
    `Achtung: 'Nur Aktien' (100% Aktienanteil) weicht von Ihrem Anlegerprofil ` +
    `'${riskProfile}' ab — empfohlene Aktienquote ca. ${equityPct}%. Erhöhtes Risiko.`
  );
}

interface ResolvedSleeveEtf {
  etf: SleeveEtf;
  price: number;
  currency: string;
  name: string;
  /** true, wenn nicht der primäre Kandidat der Liste verwendet wurde. */
  usedFallback: boolean;
}

/** Löst den ersten bepreisbaren Kandidaten einer Kandidatenliste auf. */
async function resolveFirstAvailable(
  candidates: SleeveEtf[],
  resolvePrice: ResolvePriceFn,
): Promise<ResolvedSleeveEtf | null> {
  for (let i = 0; i < candidates.length; i++) {
    const etf = candidates[i];
    try {
      const r = await resolvePrice(etf.ticker);
      if (r && Number.isFinite(r.price) && r.price > 0) {
        return {
          etf,
          price: r.price,
          currency: r.currency || etf.currency,
          name: r.name || etf.name,
          usedFallback: i > 0,
        };
      }
    } catch {
      // Resolver-Fehler → nächster Fallback
    }
  }
  return null;
}

/**
 * Kernlogik: skaliert das Aktien-Sleeve auf die Profil-Quote und ergänzt
 * ETF-Positionen für die übrigen Anlageklassen gemäss MULTI_ASSET_ALLOCATION.
 *
 * - stocksOnly=true: keine Skalierung, aber deviationNote wird gesetzt.
 * - Nicht bepreisbare Klassen (alle Fallbacks null) werden gestrichen; ihr
 *   Gewicht wird proportional auf die verbleibenden Sleeves umverteilt (Note).
 * - Der Krypto-Sleeve wird in BTC (70 %) und SOL (30 %) aufgeteilt; die Beine
 *   fallen einzeln aus, falls nicht bepreisbar.
 */
export async function applyMultiAssetSleeve(
  opts: ApplyMultiAssetSleeveOptions,
): Promise<MultiAssetSleeveResult> {
  const { equityPositions, riskProfile, stocksOnly, resolvePrice, maxFxPct, referenceCurrency = 'CHF' } = opts;
  const allocationMatrix = await getMultiAssetAllocation();
  const matrix = allocationMatrix[riskProfile];

  const emptyAllocation = (): Record<SleeveAssetKey, number> => ({
    equity: 0, bond: 0, commodity: 0, gold: 0, realestate: 0, crypto: 0,
  });

  if (stocksOnly) {
    const positions: SleevePosition[] = equityPositions.map((p) => ({
      ...p,
      weight: round2(p.weight),
      assetType: "stock",
      assetClass: "equity",
    }));
    return {
      positions,
      allocation: { ...emptyAllocation(), equity: round2(positions.reduce((s, p) => s + p.weight, 0)) },
      notes: [],
      deviationNote: buildDeviationNote(riskProfile),
    };
  }

  const notes: string[] = [];
  const positions: SleevePosition[] = [];

  // 1) Aktien-Sleeve auf die Profil-Quote skalieren
  for (const p of equityPositions) {
    positions.push({
      ...p,
      weight: round2((p.weight * matrix.equity) / 100),
      assetType: "stock",
      assetClass: "equity",
    });
  }

  // 2) ETF-Sleeves gemäss Matrix auflösen
  const sleeveClasses: AssetClass[] = ["bond", "commodity", "gold", "realestate", "crypto"];
  for (const cls of sleeveClasses) {
    const pct = matrix[cls];
    if (!pct || pct <= 0) continue;
    const candidates = MULTI_ASSET_ETFS[cls];

    if (cls === "crypto") {
      // Krypto-Sleeve: zwei Beine (BTC 70 % / SOL 30 %), fallen einzeln aus.
      const legs: Array<{ kind: "btc" | "sol"; share: number; label: string }> = [
        { kind: "btc", share: CRYPTO_BTC_SHARE, label: "Bitcoin" },
        { kind: "sol", share: CRYPTO_SOL_SHARE, label: "Solana" },
      ];
      for (const leg of legs) {
        const legCandidates = candidates.filter((c) => c.cryptoKind === leg.kind);
        const resolved = await resolveFirstAvailable(legCandidates, resolvePrice);
        if (resolved) {
          if (resolved.usedFallback) {
            notes.push(
              `Krypto-Baustein ${leg.label}: Primär-ETP (${legCandidates[0]?.ticker}) nicht bepreisbar — Fallback ${resolved.etf.ticker} verwendet.`
            );
          }
          positions.push({
            ticker: resolved.etf.ticker,
            name: resolved.name,
            weight: round2(pct * leg.share),
            assetType: "etf",
            assetClass: "crypto",
            price: resolved.price,
            currency: resolved.currency,
          });
        } else {
          notes.push(
            `Krypto-Baustein ${leg.label} konnte nicht bepreist werden (kein ETP verfügbar) — der Anteil wurde proportional auf die übrigen Anlageklassen umverteilt.`
          );
        }
      }
      continue;
    }

    const resolved = await resolveFirstAvailable(candidates, resolvePrice);
    if (resolved) {
      if (resolved.usedFallback) {
        notes.push(
          `Anlageklasse ${ASSET_CLASS_LABELS[cls]}: Primär-ETF (${candidates[0]?.ticker}) nicht bepreisbar — Fallback ${resolved.etf.ticker} verwendet.`
        );
      }
      positions.push({
        ticker: resolved.etf.ticker,
        name: resolved.name,
        weight: round2(pct),
        assetType: "etf",
        assetClass: cls,
        price: resolved.price,
        currency: resolved.currency,
      });
    } else {
      notes.push(
        `Anlageklasse ${ASSET_CLASS_LABELS[cls]} konnte nicht bepreist werden (kein ETF verfügbar) — der Anteil wurde proportional auf die übrigen Anlageklassen umverteilt.`
      );
    }
  }

  // 3) FX-Enforcement für Sleeve-ETFs: Falls ein ETF in USD/GBP ist und das
  //    FX-Limit überschreiten würde, auf den nächsten CHF/EUR-Kandidaten umschalten.
  if (maxFxPct !== undefined && maxFxPct < 100) {
    // Berechne aktuellen FX-Anteil (Aktien-Sleeve + ETF-Sleeve)
    const normCur = (c: string) => (c === 'GBp' || c === 'GBP') ? 'GBP' : c;
    const etfFxPositions = positions.filter(
      (p) => p.assetType === 'etf' && normCur(p.currency ?? referenceCurrency) !== referenceCurrency
    );
    const equityFxWeight = positions
      .filter((p) => p.assetType === 'stock' && normCur(p.currency ?? referenceCurrency) !== referenceCurrency)
      .reduce((s, p) => s + p.weight, 0);
    const etfFxWeight = etfFxPositions.reduce((s, p) => s + p.weight, 0);
    const totalFxWeight = equityFxWeight + etfFxWeight;
    const totalWeight = positions.reduce((s, p) => s + p.weight, 0) || 100;
    const fxPct = (totalFxWeight / totalWeight) * 100;
    if (fxPct > maxFxPct + 0.5) {
      // Versuche FX-Sleeve-ETFs durch CHF-Alternativen zu ersetzen
      for (const pos of etfFxPositions) {
        const cls = pos.assetClass as AssetClass;
        const candidates = MULTI_ASSET_ETFS[cls];
        const chfCandidates = candidates.filter((c) => normCur(c.currency) === referenceCurrency);
        if (!chfCandidates.length) continue;
        const resolved = await resolveFirstAvailable(chfCandidates, resolvePrice);
        if (resolved) {
          pos.ticker = resolved.etf.ticker;
          pos.name = resolved.name;
          pos.currency = resolved.currency;
          pos.price = resolved.price;
          notes.push(
            `FX-Enforcement: ${ASSET_CLASS_LABELS[cls]}-ETF auf CHF-Alternative ${resolved.etf.ticker} umgestellt (FX-Limit ${maxFxPct}% wäre sonst überschritten).`
          );
        }
      }
    }
  }

  // 4) Totalfall-Umverteilung: bei gestrichenen Klassen Summe wieder auf
  //    100 % normieren (proportional über alle Sleeves).
  const total = positions.reduce((s, p) => s + p.weight, 0);
  if (total > 0 && Math.abs(total - 100) > 0.5) {
    const factor = 100 / total;
    positions.forEach((p) => {
      p.weight = round2(p.weight * factor);
    });
  }

  // 4) Effektive Allokation nachrechnen
  const allocation = emptyAllocation();
  for (const p of positions) {
    allocation[p.assetClass] = round2(allocation[p.assetClass] + p.weight);
  }

  return { positions, allocation, notes, deviationNote: null };
}

/**
 * Stellt sicher, dass ein Sleeve-ETF in der `stocks`-Tabelle existiert
 * (category "ETF", source "ai_recommended", notes "multi_asset_sleeve|<class>",
 * listType NULL). Fehlertolerant: Fehler werden geloggt, nicht geworfen.
 * Gibt den aufgelösten Preis zurück (DB zuerst, sonst Multi-API-Fetch) oder
 * null, wenn kein gültiger Preis gefunden wurde.
 */
export async function ensureSleeveStock(etf: SleeveEtf): Promise<ResolvedPrice | null> {
  try {
    const { getStockByTicker, insertStock } = await import("../db");
    const existing = await getStockByTicker(etf.ticker);
    const existingPrice = existing?.currentPrice != null ? parseFloat(String(existing.currentPrice)) : NaN;
    if (existing && Number.isFinite(existingPrice) && existingPrice > 0) {
      return {
        price: existingPrice,
        currency: existing.currency ?? etf.currency,
        name: existing.companyName ?? etf.name,
      };
    }

    const { fetchCompleteStockData } = await import("../_core/multiApiDataMerger");
    const data = await fetchCompleteStockData(etf.ticker);
    const price = data?.currentPrice != null ? Number(data.currentPrice) : NaN;
    if (!Number.isFinite(price) || price <= 0) return null;

    if (!existing) {
      try {
        await insertStock({
          ticker: etf.ticker,
          companyName: data.companyName ?? etf.name,
          currentPrice: String(price),
          currency: data.currency ?? etf.currency,
          category: "ETF",
          source: "ai_recommended",
          notes: `multi_asset_sleeve|${etf.assetClass}`,
          listType: null,
        });
      } catch (insErr: any) {
        console.warn(`[multiAssetSleeve] insertStock für ${etf.ticker} fehlgeschlagen (non-fatal):`, insErr?.message);
      }
    }
    return {
      price,
      currency: data.currency ?? etf.currency,
      name: data.companyName ?? etf.name,
    };
  } catch (e: any) {
    console.warn(`[multiAssetSleeve] Preisauflösung für ${etf.ticker} fehlgeschlagen:`, e?.message);
    return null;
  }
}

/** Stellt sicher, dass alle übergebenen Sleeve-ETFs in `stocks` existieren. */
export async function ensureSleeveStocks(etfs: SleeveEtf[]): Promise<void> {
  for (const etf of etfs) {
    try {
      await ensureSleeveStock(etf);
    } catch (e: any) {
      console.warn(`[multiAssetSleeve] ensureSleeveStocks(${etf.ticker}) non-fatal:`, e?.message);
    }
  }
}

/**
 * DB/Preis-Wrapper für `applyMultiAssetSleeve`: löst Ticker über die
 * `stocks`-Tabelle bzw. den Multi-API-Merger auf und legt fehlende ETFs an.
 */
export function createDbPriceResolver(): ResolvePriceFn {
  const metaByTicker = new Map<string, SleeveEtf>();
  for (const list of Object.values(MULTI_ASSET_ETFS)) {
    for (const etf of list) metaByTicker.set(etf.ticker, etf);
  }
  return async (ticker: string) => {
    const etf = metaByTicker.get(ticker);
    if (!etf) return null;
    return ensureSleeveStock(etf);
  };
}
