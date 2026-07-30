import { adminProcedure, router } from "../_core/trpc";
import { MULTI_ASSET_ETFS } from "../lib/multiAssetSleeve";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { importHistoricalPrices, importHistoricalPricesForTicker } from "../jobs/importHistoricalPrices";
import { checkPriceCoverage, getRelevantTickersForPortfolio, getAllPortfolioTickers } from "../priceCoverage";
import { backfillHistoricalPrices } from "../backfillHistoricalPrices";
import { 
  checkSymbolDataStatus, 
  triggerMaxBackfillForSymbol, 
  ensureMaxBackfillForSymbols,
  autoBackfillNewSymbols,
  getBackfillQueueStatus,
  clearBackfillCache,
  clearPermanentlyFailedBackfills
} from "../autoBackfill";

export const adminRouter = router({
    /**
     * L-18: Echte Plattform-KPIs statt hartkodierter Platzhalter-Nullen.
     * Zählt Nutzer, Neuregistrierungen (30 Tage), zahlende Nutzer (hasPaid — Stripe
     * läuft als Einmalzahlung) und angelegte Portfolios direkt aus der DB.
     */
    getPlatformKpis: adminProcedure.query(async () => {
      const { getDb } = await import("../db");
      const { users, savedPortfolios } = await import("../../drizzle/schema");
      const { sql, gte } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const countOf = async (table: any, where?: any) => {
        const base = db.select({ c: sql<number>`count(*)` }).from(table);
        const [row] = where ? await base.where(where) : await base;
        return Number(row?.c ?? 0);
      };

      const [totalUsers, newUsers30d, premiumUsers, totalPortfolios] = await Promise.all([
        countOf(users),
        countOf(users, gte(users.createdAt, thirtyDaysAgo)),
        countOf(users, sql`${users.hasPaid} = 1`),
        countOf(savedPortfolios),
      ]);

            return { totalUsers, newUsers30d, premiumUsers, totalPortfolios };
    }),

    /**
     * Returns the list of users registered in the last N days with name and email.
     */
    getNewUsersDetail: adminProcedure
      .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional())
      .query(async ({ input }) => {
        const { getDb } = await import("../db");
        const { users } = await import("../../drizzle/schema");
        const { gte, desc } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const days = input?.days ?? 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            createdAt: users.createdAt,
            hasPaid: users.hasPaid,
            role: users.role,
          })
          .from(users)
          .where(gte(users.createdAt, since))
          .orderBy(desc(users.createdAt));
        return rows;
      }),

    /**
     * Returns all users with name and email for the admin user list.
     */
    getAllUsersDetail: adminProcedure.query(async () => {
        const { getDb } = await import("../db");
        const { users } = await import("../../drizzle/schema");
        const { desc } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const rows = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            createdAt: users.createdAt,
            hasPaid: users.hasPaid,
            role: users.role,
          })
          .from(users)
          .orderBy(desc(users.createdAt));
        return rows;
      }),

    exportData: adminProcedure.query(async () => {
      const { getAllStocks, getDb } = await import("../db");
      const { research, transactions } = await import("../../drizzle/schema");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      
      const stocks = await getAllStocks();
      const researchData = await db.select().from(research);
      const transactionsData = await db.select().from(transactions);
      
      return {
        exportDate: new Date().toISOString(),
        version: "1.0",
        data: {
          stocks,
          research: researchData,
          transactions: transactionsData,
        },
      };
    }),
    importData: adminProcedure
      .input(
        z.object({
          data: z.object({
            stocks: z.array(z.any()).optional(),
            research: z.array(z.any()).optional(),
            transactions: z.array(z.any()).optional(),
          }),
        })
      )
      .mutation(async ({ input }) => {
        const { getDb } = await import("../db");
        const { stocks, research, transactions } = await import("../../drizzle/schema");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        
        const importData = input as any;
        const { stocks: stocksData, research: researchData, transactions: transactionsData } = importData.data;
        
        // Delete existing data
        await db.delete(transactions);
        await db.delete(research);
        await db.delete(stocks);
        
        // Import new data
        let importedStocks = 0;
        let importedResearch = 0;
        let importedTransactions = 0;
        
        if (stocksData && stocksData.length > 0) {
          const stocksToInsert = stocksData.map((s: any) => {
            const { id, createdAt, updatedAt, ...rest } = s;
            return rest;
          });
          await db.insert(stocks).values(stocksToInsert);
          importedStocks = stocksData.length;
        }
        
        if (researchData && researchData.length > 0) {
          const researchToInsert = researchData.map((r: any) => {
            const { id, createdAt, updatedAt, ...rest } = r;
            return rest;
          });
          await db.insert(research).values(researchToInsert);
          importedResearch = researchData.length;
        }
        
        if (transactionsData && transactionsData.length > 0) {
          const transactionsToInsert = transactionsData.map((t: any) => {
            const { id, createdAt, ...rest } = t;
            return rest;
          });
          await db.insert(transactions).values(transactionsToInsert);
          importedTransactions = transactionsData.length;
        }
        
        return {
          success: true,
          imported: {
            stocks: importedStocks,
            research: importedResearch,
            transactions: importedTransactions,
          },
        };
      }),
    bulkUpdateSwissStocks: adminProcedure.mutation(async ({ ctx }) => {
      // Only admin can run bulk updates
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      const { getDb } = await import("../db");
      const { stocks } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const { fetchCompleteStockData } = await import("../_core/multiApiDataMerger");
      
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Get all Swiss stocks
      const allStocks = await db.select().from(stocks);
      const swissStocks = allStocks.filter(s => s.ticker.endsWith('.SW'));

      console.log(`[Bulk Update] Found ${swissStocks.length} Swiss stocks`);

      let updatedCount = 0;
      let failedCount = 0;
      const results: any[] = [];

      for (const stock of swissStocks) {
        try {
          console.log(`[${stock.ticker}] Fetching data...`);
          
          // Get complete data from multiApiDataMerger
          const completeData = await fetchCompleteStockData(stock.ticker);

          // Prepare update data
          const updateData: any = {};

          // Update price and currency
          if (completeData.currentPrice !== null) {
            updateData.currentPrice = completeData.currentPrice.toString();
          }
          if (completeData.currency) {
            updateData.currency = completeData.currency;
          }

          // Update Sharpe Ratio
          if (completeData.sharpe !== null && completeData.sharpe !== undefined) {
            updateData.sharpeRatio = completeData.sharpe.toString();
          }

          // Update other metrics
          if (completeData.pe !== null) updateData.peRatio = completeData.pe.toString();
          if (completeData.peg !== null) updateData.pegRatio = completeData.peg.toString();
          if (completeData.dividendYield !== null) updateData.dividendYield = completeData.dividendYield.toString();
          if (completeData.beta !== null) updateData.beta = completeData.beta.toString();
          if (completeData.volatility !== null) updateData.volatility = completeData.volatility.toString();
          if (completeData.logoUrl) updateData.logoUrl = completeData.logoUrl;

          // Update timestamp
          updateData.lastDataRefresh = new Date();

          // Execute update
          if (Object.keys(updateData).length > 1) {
            await db.update(stocks)
              .set(updateData)
              .where(eq(stocks.ticker, stock.ticker));
            
            console.log(`  ✅ Updated ${stock.ticker}`);
            updatedCount++;
            results.push({ ticker: stock.ticker, status: 'success', updates: updateData });
          }

          // Rate limiting: wait 500ms between requests
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error: any) {
          console.error(`  ❌ Failed ${stock.ticker}:`, error.message);
          failedCount++;
          results.push({ ticker: stock.ticker, status: 'failed', error: error.message });
        }
      }

      return {
        success: true,
        total: swissStocks.length,
        updated: updatedCount,
        failed: failedCount,
        results,
      };
    }),
    triggerDailyRefresh: adminProcedure.mutation(async ({ ctx }) => {
      // Only admin can trigger daily refresh
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      const { refreshAllStocks } = await import("../_core/dailyRefreshCron");
      const result = await refreshAllStocks();
      
      return result;
    }),
    getDataQualityMetrics: adminProcedure.query(async ({ ctx }) => {
      // Only admin can view data quality metrics
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      const { calculateDataQualityMetrics } = await import("../_core/dataQualityMetrics");
      const metrics = await calculateDataQualityMetrics();
      
      return metrics;
    }),
    
    triggerYTDUpdate: adminProcedure.mutation(async ({ ctx }) => {
      // Only admin can trigger YTD update
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      const { manualYTDUpdate } = await import("../cron/ytdUpdater");
      await manualYTDUpdate();
      
      return { success: true, message: "YTD update completed" };
    }),
    
    refreshPrices: adminProcedure.query(async ({ ctx }) => {
      // Only admin can refresh prices
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      const { refreshAllStocks } = await import("../_core/dailyRefreshCron");
      await refreshAllStocks();
      
      return { success: true, message: "Prices refreshed successfully" };
    }),
    
    refreshCharts: adminProcedure.query(async ({ ctx }) => {
      // Only admin can refresh charts
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      // Charts are updated via refreshAllStocks
      const { refreshAllStocks } = await import("../_core/dailyRefreshCron");
      await refreshAllStocks();
      
      return { success: true, message: "Charts refreshed successfully" };
    }),
    
    refreshNews: adminProcedure.query(async ({ ctx }) => {
      // Only admin can refresh news
      if (ctx.user?.role !== 'admin') {
        throw new Error('Unauthorized: Admin access required');
      }

      // News updates are disabled (memory optimization)
      return { success: true, message: "News updates are currently disabled for memory optimization" };
    }),
    
    /**
     * Trigger historical price import for all tickers
     */
    importHistoricalPrices: adminProcedure
      .input(
        z.object({
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          forceRefresh: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        // Fire-and-forget: return immediately to avoid 524 Cloudflare timeout
        // The import runs in the background (can take 5-15 min for full backfill)
        importHistoricalPrices(input.fromDate, input.toDate, input.forceRefresh)
          .then((result) => {
            console.log(`[importHistoricalPrices] Background import complete: ${result.tickersProcessed} tickers, ${result.pricesImported} prices`);
          })
          .catch((err: any) => {
            console.error('[importHistoricalPrices] Background import error:', err?.message);
          });

        // D5 (Schnellaktionen-Audit): keine 0er-Zählwerte mehr zurückgeben —
        // der Client zeigte daraus «0 Ticker, 0 Kurse importiert», obwohl der
        // Import erst startet. Ergebnis steht in den Server-Logs.
        return {
          success: true,
          started: true,
          message: 'Kursdaten-Import gestartet — läuft im Hintergrund (5–15 Min). Server-Logs zeigen das Ergebnis.',
        };
      }),

    /**
     * Trigger immediate backfill for all sleeve ETF tickers (AGGH.SW, ZGLD.SW, CMDY, ABTC.SW, REET, ...)
     */
    backfillSleeveEtfs: adminProcedure
      .mutation(async () => {
        const allTickers = Object.values(MULTI_ASSET_ETFS).flat().map(e => e.ticker);
        const results: { ticker: string; success: boolean; pricesImported: number; error?: string }[] = [];
        for (const ticker of allTickers) {
          try {
            const result = await importHistoricalPricesForTicker(ticker);
            results.push({ ticker, success: result.success, pricesImported: result.pricesImported });
          } catch (err: any) {
            results.push({ ticker, success: false, pricesImported: 0, error: err?.message });
          }
        }
        return {
          success: true,
          tickers: allTickers,
          results,
          totalPricesImported: results.reduce((s, r) => s + r.pricesImported, 0),
        };
      }),

    importHistoricalPricesForTicker: adminProcedure
      .input(
        z.object({
          ticker: z.string(),
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // Only admin can import historical prices
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }
        
        const result = await importHistoricalPricesForTicker(input.ticker, input.fromDate, input.toDate);
        return result;
      }),

    /**
     * Check price coverage for specified tickers
     * Useful for debugging missing historical price data
     */
    priceCoverage: adminProcedure
      .input(z.object({
        tickers: z.array(z.string()).optional(),
        portfolioId: z.number().optional(),
        from: z.string().optional(),
        to: z.string().optional()
      }))
      .query(async ({ ctx, input }) => {
        // Only admin can check price coverage
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        let tickers: string[] = [];

        // If portfolioId provided, get tickers from that portfolio
        if (input.portfolioId) {
          tickers = await getRelevantTickersForPortfolio(input.portfolioId);
        }
        // If tickers array provided, use that
        else if (input.tickers && input.tickers.length > 0) {
          tickers = input.tickers;
        }
        // Otherwise get all portfolio tickers
        else {
          tickers = await getAllPortfolioTickers();
        }

        if (tickers.length === 0) {
          return {
            tickers: [],
            distinctTickerSample: [],
            requestedRange: {
              from: input.from || "2025-01-01",
              to: input.to || new Date().toISOString().split('T')[0]
            }
          };
        }

        return await checkPriceCoverage(tickers, input.from, input.to);
      }),

    /**
     * Backfill historical prices for specified tickers
     * Admin-only operation to populate missing historical price data
     */
    backfillPrices: adminProcedure
      .input(z.object({
        tickers: z.array(z.string()).optional(),
        portfolioId: z.number().optional(),
        from: z.string(),
        to: z.string()
      }))
      .mutation(async ({ ctx, input }) => {
        // Only admin can backfill prices
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        let tickers: string[] = [];

        // If portfolioId provided, get tickers from that portfolio
        if (input.portfolioId) {
          tickers = await getRelevantTickersForPortfolio(input.portfolioId);
        }
        // If tickers array provided, use that
        else if (input.tickers && input.tickers.length > 0) {
          tickers = input.tickers;
        }
        // Otherwise get all portfolio tickers
        else {
          tickers = await getAllPortfolioTickers();
        }

        if (tickers.length === 0) {
          throw new Error('No tickers found to backfill');
        }

        console.log(`[adminRouter.backfillPrices] Starting backfill for ${tickers.length} tickers`);

        const result = await backfillHistoricalPrices(tickers, input.from, input.to);

        return {
          success: result.success,
          summary: {
            tickersProcessed: result.tickersProcessed,
            pricesInserted: result.pricesInserted,
            pricesUpdated: result.pricesUpdated,
            missingTickers: result.missingTickers,
            errorCount: result.errors.length
          },
          errors: result.errors.slice(0, 10) // Return first 10 errors only
        };
      }),

    /**
     * Get all portfolio tickers
     * Useful for seeing what tickers are in use across all portfolios
     */
    getAllTickers: adminProcedure
      .query(async ({ ctx }) => {
        // Only admin can get all tickers
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        const tickers = await getAllPortfolioTickers();
        return {
          tickers,
          count: tickers.length
        };
      }),

    /**
     * Get auto-backfill queue status
     * Shows pending and recently completed backfills
     */
    getBackfillStatus: adminProcedure
      .query(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        return getBackfillQueueStatus();
      }),

    /**
     * Check data status for specific symbols
     * Returns information about available historical data
     */
    checkSymbolsDataStatus: adminProcedure
      .input(z.object({
        tickers: z.array(z.string())
      }))
      .query(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        const statuses = await Promise.all(
          input.tickers.map(ticker => checkSymbolDataStatus(ticker))
        );

        return {
          statuses,
          summary: {
            total: statuses.length,
            withData: statuses.filter(s => s.hasData).length,
            needingBackfill: statuses.filter(s => s.needsBackfill).length,
            currentlyBackfilling: statuses.filter(s => s.isBackfilling).length
          }
        };
      }),

    /**
     * Trigger MAX backfill for specific symbols
     * Fetches 5 years of historical data for each symbol
     */
    triggerMaxBackfill: adminProcedure
      .input(z.object({
        tickers: z.array(z.string()),
        force: z.boolean().optional().default(false)
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        console.log(`[adminRouter.triggerMaxBackfill] Starting MAX backfill for ${input.tickers.length} tickers`);
        
        const results = await ensureMaxBackfillForSymbols(input.tickers, input.force);

        return {
          results,
          summary: {
            total: results.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            totalPricesInserted: results.reduce((sum, r) => sum + r.pricesInserted, 0),
            totalDuration: results.reduce((sum, r) => sum + r.duration, 0)
          }
        };
      }),

    /**
     * Auto-detect and backfill new symbols
     * Checks all provided symbols and triggers backfill for those without sufficient data
     */
    autoBackfillSymbols: adminProcedure
      .input(z.object({
        tickers: z.array(z.string()).optional()
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        // If no tickers provided, get all portfolio tickers
        let tickers = input.tickers || [];
        if (tickers.length === 0) {
          tickers = await getAllPortfolioTickers();
        }

        console.log(`[adminRouter.autoBackfillSymbols] Checking ${tickers.length} symbols for auto-backfill`);
        
        const result = await autoBackfillNewSymbols(tickers);

        return {
          newSymbolsDetected: result.newSymbolsDetected,
          statuses: result.statuses,
          backfillResults: result.backfillResults,
          summary: {
            totalChecked: result.statuses.length,
            newSymbols: result.newSymbolsDetected,
            successfulBackfills: result.backfillResults.filter(r => r.success).length,
            failedBackfills: result.backfillResults.filter(r => !r.success).length,
            totalPricesInserted: result.backfillResults.reduce((sum, r) => sum + r.pricesInserted, 0)
          }
        };
      }),

    /**
     * Clear backfill cache
     * Forces re-check of all symbols on next backfill request
     */
    clearBackfillCache: adminProcedure
      .mutation(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }

        clearBackfillCache();
        return { success: true, message: 'Backfill cache cleared' };
      }),

    /**
     * Clear permanently-failed backfills registry
     * Useful when a ticker becomes available at EODHD after being absent
     */
    clearPermanentlyFailedBackfills: adminProcedure
      .input(z.object({ ticker: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') {
          throw new Error('Unauthorized: Admin access required');
        }
        clearPermanentlyFailedBackfills(input.ticker);
        return { success: true, message: input.ticker ? `Registry für ${input.ticker} geleert` : 'Alle permanently-failed Registries geleert' };
      }),

    // ─── ML Trainer ───────────────────────────────────────────────────────────

    /**
     * Get the current status of the ML model:
     * latest artifact metadata, metrics, and whether a model is active.
     */
    mlGetStatus: adminProcedure
      .query(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');

        const { getDb } = await import('../db');
        const { modelArtifacts } = await import('../../drizzle/schema');
        const { desc } = await import('drizzle-orm');
        const db = await getDb();
        if (!db) return { hasModel: false, artifacts: [] };

        const rows = await db
          .select({
            id: modelArtifacts.id,
            kind: modelArtifacts.kind,
            version: modelArtifacts.version,
            status: modelArtifacts.status,
            format: modelArtifacts.format,
            trainStart: modelArtifacts.trainStart,
            trainEnd: modelArtifacts.trainEnd,
            universeSize: modelArtifacts.universeSize,
            metrics: modelArtifacts.metrics,
            promotedAt: modelArtifacts.promotedAt,
            createdAt: modelArtifacts.createdAt,
            // modelBlob intentionally omitted (large)
          })
          .from(modelArtifacts)
          .orderBy(desc(modelArtifacts.createdAt))
          .limit(1);

        const active = await db
          .select({
            id: modelArtifacts.id,
            kind: modelArtifacts.kind,
            version: modelArtifacts.version,
            status: modelArtifacts.status,
            trainStart: modelArtifacts.trainStart,
            trainEnd: modelArtifacts.trainEnd,
            universeSize: modelArtifacts.universeSize,
            metrics: modelArtifacts.metrics,
            promotedAt: modelArtifacts.promotedAt,
            createdAt: modelArtifacts.createdAt,
          })
          .from(modelArtifacts)
          .where((await import('drizzle-orm')).eq(modelArtifacts.status, 'active'))
          .limit(1);

        const analyticsUrl = process.env.ANALYTICS_SERVICE_URL;
        let serviceOnline = false;
        if (analyticsUrl) {
          const healthUrl = `${analyticsUrl.replace(/\/$/, '')}/health`;
          // Two attempts with 8s timeout each — Railway cold starts can take 3-5s
          for (let attempt = 0; attempt < 2 && !serviceOnline; attempt++) {
            try {
              const r = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
              serviceOnline = r.ok;
            } catch { /* offline or timeout, try once more */ }
          }
        }

        return {
          hasModel: active.length > 0,
          activeModel: active[0] ?? null,
          latestRun: rows[0] ?? null,
          serviceOnline,
          analyticsServiceConfigured: !!analyticsUrl,
        };
      }),

    /**
     * Get full training history (all artifacts, newest first).
     */
    mlGetHistory: adminProcedure
      .input(z.object({ limit: z.number().min(1).max(100).optional().default(20) }))
      .query(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');

        const { getDb } = await import('../db');
        const { modelArtifacts } = await import('../../drizzle/schema');
        const { desc } = await import('drizzle-orm');
        const db = await getDb();
        if (!db) return { runs: [] };

        const rows = await db
          .select({
            id: modelArtifacts.id,
            kind: modelArtifacts.kind,
            version: modelArtifacts.version,
            status: modelArtifacts.status,
            format: modelArtifacts.format,
            trainStart: modelArtifacts.trainStart,
            trainEnd: modelArtifacts.trainEnd,
            universeSize: modelArtifacts.universeSize,
            metrics: modelArtifacts.metrics,
            promotedAt: modelArtifacts.promotedAt,
            createdAt: modelArtifacts.createdAt,
          })
          .from(modelArtifacts)
          .orderBy(desc(modelArtifacts.createdAt))
          .limit(input.limit);

        return { runs: rows };
      }),

    // ─────────────────────────────────────────────────────────────────────
    // Signal Performance Analytics (Admin only)
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Aggregierte Signal-Performance-Metriken je Engine und Regime.
     * Basis für Admin-Dashboard zur Optimierung des Signalmix.
     */
    getSignalPerformance: adminProcedure
      .input(z.object({
        days: z.number().default(90),
        engine: z.string().optional(),
        regime: z.string().optional(),
      }))
      .query(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');

        const { getDb } = await import('../db');
        const { signalHistory } = await import('../../drizzle/schema');
        const { and, gte, isNotNull, sql, eq } = await import('drizzle-orm');
        const db = await getDb();
        if (!db) throw new Error('DB not available');

        const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

        const conditions: any[] = [
          gte(signalHistory.computedAt, since),
          isNotNull(signalHistory.evaluatedAt),
          isNotNull(signalHistory.directionCorrect),
        ];
        if (input.engine) conditions.push(eq(signalHistory.selectedEngine, input.engine));
        if (input.regime) conditions.push(eq(signalHistory.regime, input.regime));

        const rows = await db
          .select()
          .from(signalHistory)
          .where(and(...conditions))
          .orderBy(sql`${signalHistory.computedAt} DESC`)
          .limit(2000);

        // Aggregation je Engine
        const engineMap: Record<string, {
          engine: string; totalSignals: number; evaluatedSignals: number;
          hitRateSum: number; returnSum: number; convictionSum: number;
          // F-14: Alpha nur über Zeilen mit Benchmark-Daten aggregieren
          alphaSum: number; alphaCount: number; alphaHitSum: number;
          byRegime: Record<string, { hitSum: number; count: number; retSum: number }>;
          byAction: Record<string, { hitSum: number; count: number; alphaSum: number; alphaCount: number; alphaHitSum: number }>;
        }> = {};

        for (const row of rows) {
          const eng = row.selectedEngine;
          if (!engineMap[eng]) {
            engineMap[eng] = { engine: eng, totalSignals: 0, evaluatedSignals: 0,
              hitRateSum: 0, returnSum: 0, convictionSum: 0,
              alphaSum: 0, alphaCount: 0, alphaHitSum: 0, byRegime: {}, byAction: {} };
          }
          const s = engineMap[eng];
          s.totalSignals++;
          s.evaluatedSignals++;
          const correct = row.directionCorrect === 1;
          s.hitRateSum += correct ? 1 : 0;
          s.returnSum += parseFloat(row.actualReturnPct?.toString() ?? '0');
          s.convictionSum += parseFloat(row.conviction.toString());

          const alpha = row.alphaPct != null ? parseFloat(row.alphaPct.toString()) : null;
          if (alpha != null && !isNaN(alpha)) {
            s.alphaSum += alpha;
            s.alphaCount++;
            s.alphaHitSum += alpha > 0 ? 1 : 0;
          }

          const reg = row.regime;
          if (!s.byRegime[reg]) s.byRegime[reg] = { hitSum: 0, count: 0, retSum: 0 };
          s.byRegime[reg].count++;
          s.byRegime[reg].hitSum += correct ? 1 : 0;
          s.byRegime[reg].retSum += parseFloat(row.actualReturnPct?.toString() ?? '0');

          const act = row.action;
          if (!s.byAction[act]) s.byAction[act] = { hitSum: 0, count: 0, alphaSum: 0, alphaCount: 0, alphaHitSum: 0 };
          s.byAction[act].count++;
          s.byAction[act].hitSum += correct ? 1 : 0;
          if (alpha != null && !isNaN(alpha)) {
            s.byAction[act].alphaSum += alpha;
            s.byAction[act].alphaCount++;
            s.byAction[act].alphaHitSum += alpha > 0 ? 1 : 0;
          }
        }

        const engineStats = Object.values(engineMap).map(s => ({
          engine: s.engine,
          totalSignals: s.totalSignals,
          evaluatedSignals: s.evaluatedSignals,
          hitRate: s.evaluatedSignals > 0 ? s.hitRateSum / s.evaluatedSignals : 0,
          avgReturn: s.evaluatedSignals > 0 ? s.returnSum / s.evaluatedSignals : 0,
          avgConviction: s.evaluatedSignals > 0 ? s.convictionSum / s.evaluatedSignals : 0,
          // F-14 (additiv): Ø Alpha & Alpha-Trefferquote (Alpha > 0), nur wo Benchmark-Daten existieren
          avgAlpha: s.alphaCount > 0 ? s.alphaSum / s.alphaCount : null,
          alphaHitRate: s.alphaCount > 0 ? s.alphaHitSum / s.alphaCount : null,
          alphaCount: s.alphaCount,
          byRegime: Object.fromEntries(Object.entries(s.byRegime).map(([k, v]) => [k, {
            hitRate: v.count > 0 ? v.hitSum / v.count : 0,
            count: v.count,
            avgReturn: v.count > 0 ? v.retSum / v.count : 0,
          }])),
          byAction: Object.fromEntries(Object.entries(s.byAction).map(([k, v]) => [k, {
            hitRate: v.count > 0 ? v.hitSum / v.count : 0,
            count: v.count,
            avgAlpha: v.alphaCount > 0 ? v.alphaSum / v.alphaCount : null,
            alphaHitRate: v.alphaCount > 0 ? v.alphaHitSum / v.alphaCount : null,
            alphaCount: v.alphaCount,
          }])),
        }));

        // Kalibrierungskurve
        const buckets = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
        const calibration = buckets.slice(0, -1).map((min, i) => {
          const max = buckets[i + 1];
          const inBucket = rows.filter(r =>
            parseFloat(r.conviction.toString()) >= min &&
            parseFloat(r.conviction.toString()) < max
          );
          const hits = inBucket.filter(r => r.directionCorrect === 1).length;
          return {
            bucket: `${Math.round(min * 100)}-${Math.round(max * 100)}%`,
            minConviction: min, maxConviction: max,
            hitRate: inBucket.length > 0 ? hits / inBucket.length : 0,
            count: inBucket.length,
          };
        });

        // Letzte 50 Signale (alle, nicht nur evaluierte)
        const recentSignals = await db
          .select()
          .from(signalHistory)
          .where(gte(signalHistory.computedAt, since))
          .orderBy(sql`${signalHistory.computedAt} DESC`)
          .limit(50);

        return {
          engineStats,
          calibration,
          recentSignals,
          totalEvaluated: rows.length,
          overallHitRate: rows.length > 0
            ? rows.filter(r => r.directionCorrect === 1).length / rows.length
            : null,
        };
      }),

    /** Manueller Trigger: Signal-Snapshot für alle Portfolio-Aktien */
    triggerSignalSnapshot: adminProcedure
      .mutation(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { snapshotSignalsForPortfolio } = await import('../cron/signalEvaluationCron');
        snapshotSignalsForPortfolio().catch(console.error);
        return { started: true, message: 'Signal-Snapshot gestartet (läuft im Hintergrund)' };
      }),

    /** Manueller Trigger: Lookback-Evaluation */
    triggerSignalEvaluation: adminProcedure
      .mutation(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { evaluatePendingSignals } = await import('../cron/signalEvaluationCron');
        evaluatePendingSignals().catch(console.error);
        return { started: true, message: 'Lookback-Evaluation gestartet' };
      }),

    // ── Phase 3: Risk Threshold Kalibrierung ─────────────────────────────────

    /** Kalibrierungsstatus: Cache-Stats und kalibrierte Ticker anzeigen */
    getRiskCalibrationStatus: adminProcedure
      .query(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { getCacheStats } = await import('../lib/signals/riskThresholdCalibrator');
        const stats = getCacheStats();
        return {
          cachedTickers: stats.tickers,
          cacheSize: stats.size,
          description: 'Kalibrierte Schwellenwerte im In-Memory Cache (TTL: 24h)',
        };
      }),

    /** Kalibrierung für einen einzelnen Ticker triggern */
    calibrateRiskThresholdsForTicker: adminProcedure
      .input(z.object({ ticker: z.string() }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const yahooFinance = (await import('yahoo-finance2')).default;
        const { calibrateRiskThresholds, setCachedThresholds } = await import('../lib/signals/riskThresholdCalibrator');

        const ticker = input.ticker;
        try {
          const chartResult = await (yahooFinance as any).chart(ticker, {
            period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            period2: new Date().toISOString().split('T')[0],
            interval: '1d',
          });
          const prices: number[] = ((chartResult as any).quotes ?? [])
            .map((q: any) => q.close)
            .filter((c: any) => c != null && c > 0);

          if (prices.length < 100) {
            return { success: false, message: `Zu wenig Daten: ${prices.length} Preispunkte (mind. 100 nötig)` };
          }

          const start = Date.now();
          const thresholds = calibrateRiskThresholds(ticker, prices);
          setCachedThresholds(ticker, thresholds);
          const durationMs = Date.now() - start;

          return {
            success: true,
            ticker,
            durationMs,
            dataPoints: prices.length,
            numFolds: thresholds.meta.numFolds,
            confidence: thresholds.meta.confidence,
            avgOosImprovement: thresholds.meta.avgOosImprovement,
            calibratedAt: thresholds.meta.calibratedAt,
            thresholds: {
              volDampLevel1: thresholds.vol.dampLevel1,
              volDampLevel2: thresholds.vol.dampLevel2,
              volBlockLevel: thresholds.vol.blockLevel,
              ddDampLevel1: thresholds.drawdown.dampLevel1,
              ddDampLevel2: thresholds.drawdown.dampLevel2,
            },
            regimeMultipliers: thresholds.regimeMultipliers,
          };
        } catch (e) {
          return { success: false, message: `Fehler: ${(e as Error).message}` };
        }
      }),

    /** Cache leeren (erzwingt Neukalibrierung beim nächsten Request) */
    clearRiskCalibrationCache: adminProcedure
      .mutation(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { clearThresholdCache } = await import('../lib/signals/riskThresholdCalibrator');
        clearThresholdCache();
        return { success: true, message: 'Kalibrierungs-Cache geleert' };
      }),

    // ─── App Settings (Diversifikationsregeln, Gebühren) ───────────────
    getAppSettings: adminProcedure
      .query(async ({ ctx }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { getDb } = await import("../db");
        const { appSettings } = await import("../../drizzle/schema");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const rows = await db.select().from(appSettings);
        return rows;
      }),

    updateAppSetting: adminProcedure
      .input(z.object({
        key: z.string(),
        value: z.any(),
        description: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { getDb } = await import("../db");
        const { appSettings } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        
        await db.insert(appSettings)
          .values({ key: input.key, value: input.value, description: input.description })
          .onDuplicateKeyUpdate({ set: { value: input.value, description: input.description } });
        return { success: true };
      }),

    // ─── KI-Vorschlag: Modellwahl pro Rolle ────────────────────────────────

    getProposalModels: adminProcedure.query(async () => {
      const { getProposalModelConfig, DEFAULT_PROPOSAL_MODELS, PROVIDER_LABELS } = await import("../lib/proposalModels");
      const config = await getProposalModelConfig();
      return { config, defaults: DEFAULT_PROPOSAL_MODELS, labels: PROVIDER_LABELS };
    }),

    setProposalModels: adminProcedure
      .input(z.object({
        ensemble: z.boolean(),
        analysis: z.enum(["kimi", "gemini", "claude", "perplexity", "groq", "omniroute"]),
        challengerB: z.enum(["kimi", "gemini", "claude", "perplexity", "groq", "omniroute"]),
        synthesis: z.enum(["kimi", "gemini", "claude", "perplexity", "groq", "omniroute"]),
        text: z.enum(["kimi", "gemini", "claude", "perplexity", "groq", "omniroute"]),
        autoApply: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user?.role !== 'admin') throw new Error('Unauthorized: Admin access required');
        const { getDb } = await import("../db");
        const { appSettings } = await import("../../drizzle/schema");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        await db.insert(appSettings)
          .values({ key: "proposal_agent_models", value: input, description: "Modellwahl pro Rolle für KI-Portfolio-Vorschläge" })
          .onDuplicateKeyUpdate({ set: { value: input } });
        return { success: true };
      }),

    // ─── Score-Schwellen Konfiguration ─────────────────────────────────────

    getScoreConfig: adminProcedure.query(async () => {
      const { getScoreThresholds, DEFAULT_SCORE_CONFIG } = await import("../lib/portfolioQualityScore");
      const config = await getScoreThresholds();
      return { config, defaults: DEFAULT_SCORE_CONFIG };
    }),

    updateScoreConfig: adminProcedure
      .input(z.object({
        config: z.any(), // ScoreThresholdsConfig shape
      }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("../db");
        const { appSettings } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const { invalidateScoreConfigCache } = await import("../lib/portfolioQualityScore");
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        // Validate basic structure
        const cfg = input.config;
        if (!cfg?.componentWeights || !cfg?.subWeights || !cfg?.thresholds) {
          throw new Error("Invalid config structure: must have componentWeights, subWeights, thresholds");
        }

        // Validate component weights sum to ~1.0
        const wSum = Object.values(cfg.componentWeights as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
        if (Math.abs(wSum - 1.0) > 0.01) {
          throw new Error(`Component weights must sum to 1.0 (got ${wSum.toFixed(3)})`);
        }

        // Audit-Trail (Compliance): der Score beeinflusst Kaufhinweise, deshalb
        // wer/wann/alte→neue Gewichte festhalten. Ablage als JSON in appSettings
        // (keine eigene Tabelle/Migration nötig), letzte 30 Einträge.
        try {
          const rows = await db.select().from(appSettings).where(eq(appSettings.key, "score_thresholds"));
          const prevWeights = (rows[0]?.value as any)?.componentWeights ?? null;
          const auditRows = await db.select().from(appSettings).where(eq(appSettings.key, "score_thresholds_audit"));
          const history: any[] = Array.isArray(auditRows[0]?.value) ? (auditRows[0]!.value as any[]) : [];
          history.push({
            at: new Date().toISOString(),
            userId: ctx.user.id,
            email: ctx.user.email ?? null,
            oldWeights: prevWeights,
            newWeights: cfg.componentWeights,
          });
          const trimmed = history.slice(-30);
          await db.insert(appSettings)
            .values({ key: "score_thresholds_audit", value: trimmed, description: "Audit-Trail: Änderungen an den Score-Schwellen" })
            .onDuplicateKeyUpdate({ set: { value: trimmed } });
        } catch (e) {
          console.warn("[updateScoreConfig] Audit-Log fehlgeschlagen:", (e as Error).message);
        }

        await db.insert(appSettings)
          .values({ key: "score_thresholds", value: cfg, description: "Portfolio Quality Score Schwellenwerte" })
          .onDuplicateKeyUpdate({ set: { value: cfg, description: "Portfolio Quality Score Schwellenwerte" } });

        // Invalidate in-memory cache
        invalidateScoreConfigCache();

        return { success: true };
      }),

    /** Audit-Trail der Score-Schwellen-Änderungen (neueste zuerst). */
    getScoreConfigAudit: adminProcedure.query(async () => {
      const { getDb } = await import("../db");
      const { appSettings } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { entries: [] as any[] };
      const rows = await db.select().from(appSettings).where(eq(appSettings.key, "score_thresholds_audit"));
      const history: any[] = Array.isArray(rows[0]?.value) ? (rows[0]!.value as any[]) : [];
      return { entries: [...history].reverse() };
    }),

    /**
     * Verbesserungs-Timeline (KIMI-Audit ③): Out-of-Sample-Güte je Optimizer-Lauf
     * (signalWeights) und je ML-Modell-Version (modelArtifacts) über die Zeit.
     * Reine Leseansicht — zeigt, wann welche Version aktiv wurde und wie sie OOS
     * abschnitt. Fehlertolerant (fehlende Tabellen/Felder → leere Serie).
     */
    getImprovementTimeline: adminProcedure.query(async () => {
      const { getDb } = await import("../db");
      const { signalWeights, modelArtifacts } = await import("../../drizzle/schema");
      const { desc } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { weights: [] as any[], models: [] as any[] };

      const num = (v: any): number | null => {
        const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
        return Number.isFinite(n) ? n : null;
      };

      let weights: any[] = [];
      try {
        const rows = await db
          .select({
            id: signalWeights.id, name: signalWeights.name, hitRate: signalWeights.hitRate,
            isActive: signalWeights.isActive, optimizerLog: signalWeights.optimizerLog,
            lastRunAt: signalWeights.lastRunAt, createdAt: signalWeights.createdAt,
          })
          .from(signalWeights)
          .orderBy(desc(signalWeights.createdAt))
          .limit(60);
        weights = rows.map((r) => {
          let wf: any = null, gate: any = null;
          try { const log = r.optimizerLog ? JSON.parse(r.optimizerLog as string) : null; wf = log?.walkForward ?? null; gate = log?.gate ?? null; } catch { /* alt/ungültig */ }
          return {
            id: r.id, name: r.name, isActive: r.isActive === 1,
            at: (r.lastRunAt ?? r.createdAt) as Date,
            inSampleHitRate: num(wf?.inSampleHitRate),
            oosHitRate: num(wf?.outOfSampleHitRate),
            incumbentOosHitRate: num(wf?.incumbentOutOfSampleHitRate),
            overfitRatio: num(wf?.overfitRatio),
            // Gate-Metadaten (ab ①). Fallback: Name-Präfix rejected_/optimized_.
            activated: gate ? !!gate.activated : (typeof r.name === "string" ? !r.name.startsWith("rejected_") : true),
            triggeredBy: gate?.triggeredBy ?? null,
            gateReason: gate?.reason ?? null,
          };
        }).reverse();
      } catch { weights = []; }

      let models: any[] = [];
      try {
        const rows = await db
          .select({
            id: modelArtifacts.id, kind: modelArtifacts.kind, version: modelArtifacts.version,
            status: modelArtifacts.status, metrics: modelArtifacts.metrics,
            promotedAt: modelArtifacts.promotedAt, createdAt: modelArtifacts.createdAt,
          })
          .from(modelArtifacts)
          .orderBy(desc(modelArtifacts.createdAt))
          .limit(60);
        models = rows.map((r) => {
          const m: any = r.metrics ?? {};
          return {
            id: r.id, kind: r.kind, version: r.version, status: r.status,
            at: (r.promotedAt ?? r.createdAt) as Date,
            promoted: r.status === "active" || r.status === "archived",
            hitRate: num(m.hitRate), alpha: num(m.alpha), overfitRatio: num(m.overfitRatio),
          };
        }).reverse();
      } catch { models = []; }

      // ④ Stack-A: Outcome des nutzersichtbaren Combined Score.
      let combinedScoreOutcome: any = { evaluated: 0, hitRate: null, avgAlphaPct: null, pendingSnapshots: 0 };
      try {
        const { getCombinedScoreOutcomeStats } = await import("../cron/combinedScoreOutcome");
        combinedScoreOutcome = await getCombinedScoreOutcomeStats();
      } catch { /* Tabelle evtl. noch nicht vorhanden */ }

      return { weights, models, combinedScoreOutcome };
    }),

    /**
     * Einheitlicher Outcome-Überblick (KIMI-Audit 3.6a): alle vier
     * Erfolgsmessquellen mit denselben Kennzahlen nebeneinander — ohne die
     * Tabellen physisch zusammenzuführen.
     */
    getOutcomeOverview: adminProcedure.query(async () => {
      try {
        const { summarizeOutcomes } = await import("../lib/outcomeSummary");
        return { sources: await summarizeOutcomes() };
      } catch {
        return { sources: [] as any[] };
      }
    }),

    /** Preview: calculate score with custom config without saving */
    previewScoreConfig: adminProcedure
      .input(z.object({
        config: z.any(),
        sampleInput: z.any(),
        goal: z.enum(["dividends", "growth", "balanced"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { calculatePortfolioQualityScore } = await import("../lib/portfolioQualityScore");
        const result = calculatePortfolioQualityScore(input.sampleInput, input.config, input.goal ?? null);
        return result;
      }),

    // ─── KI-Alpha: regime-abhängige Signal-Konfiguration (Track A, P1+P2) ───

    /** Konfiguration je Regime: admin-gesetzte Qualität/Trading-Gewichte + gelernte Engine-Gewichte. */
    getRegimeSignalConfig: adminProcedure.query(async () => {
      const { getRegimeConfig } = await import("../analytics/regimeSignalMemory");
      return getRegimeConfig();
    }),

    /** P1: Qualität/Trading-Verhältnis eines Regimes setzen (wird auf Summe 1 normiert). */
    setRegimeBlend: adminProcedure
      .input(z.object({
        regime: z.string().min(1),
        quality: z.number().min(0),
        trading: z.number().min(0),
      }).refine((v) => v.quality + v.trading > 0, { message: "Mindestens ein Gewicht muss > 0 sein" }))
      .mutation(async ({ input }) => {
        const { setRegimeBlend } = await import("../analytics/regimeSignalMemory");
        await setRegimeBlend(input.regime, input.quality, input.trading);
        return { success: true };
      }),

    /** P2: Engine-Gewichte je Regime aus dem gemessenen Alpha (signal_history) neu lernen. */
    recomputeRegimeWeights: adminProcedure.mutation(async () => {
      const { recomputeRegimeEngineWeights } = await import("../analytics/regimeSignalMemory");
      return recomputeRegimeEngineWeights();
    }),

    /** Diagnose: ist die Python-ML-Pipeline (ANALYTICS_SERVICE_URL) konfiguriert/erreichbar? */
    analyticsServiceStatus: adminProcedure.query(async () => {
      const { getAnalyticsServiceStatus } = await import("../lib/analyticsServiceStatus");
      return getAnalyticsServiceStatus();
    }),

    // ─── Asset-Class Scoring Weights ─────────────────────────────────────────

    /**
     * Get asset-class scoring weights from appSettings.
     * Returns defaults if not yet configured.
     */
    getAssetClassWeights: adminProcedure.query(async () => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) return { success: false, weights: null };
      try {
        const { appSettings } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const rows = await db
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, "asset_class_weights"))
          .limit(1);
        if (rows.length > 0) {
          return { success: true, weights: JSON.parse(rows[0].value as string) };
        }
        // Return built-in defaults
        const defaults = {
          bond:      { rsiWeight: 0.3, rangeWeight: 0.2, yieldWeight: 0.5 },
          gold:      { rsiWeight: 0.4, rangeWeight: 0.4, ytdWeight: 0.2 },
          commodity: { rsiWeight: 0.4, rangeWeight: 0.4, ytdWeight: 0.2 },
          crypto:    { rsiWeight: 0.35, rangeWeight: 0.35, ytdWeight: 0.3 },
          realestate:{ rsiWeight: 0.3, rangeWeight: 0.2, yieldWeight: 0.5 },
        };
        return { success: true, weights: defaults };
      } catch (err: any) {
        return { success: false, weights: null };
      }
    }),

    /**
     * Persist asset-class scoring weights to appSettings.
     */
    updateAssetClassWeights: adminProcedure
      .input(
        z.object({
          bond:       z.object({ rsiWeight: z.number(), rangeWeight: z.number(), yieldWeight: z.number() }),
          gold:       z.object({ rsiWeight: z.number(), rangeWeight: z.number(), ytdWeight: z.number() }),
          commodity:  z.object({ rsiWeight: z.number(), rangeWeight: z.number(), ytdWeight: z.number() }),
          crypto:     z.object({ rsiWeight: z.number(), rangeWeight: z.number(), ytdWeight: z.number() }),
          realestate: z.object({ rsiWeight: z.number(), rangeWeight: z.number(), yieldWeight: z.number() }),
        })
      )
      .mutation(async ({ input }) => {
        const { getDb } = await import("../db");
        const db = await getDb();
        if (!db) return { success: false, message: "DB nicht verfügbar" };
        try {
          const { appSettings } = await import("../../drizzle/schema");
          await db
            .insert(appSettings)
            .values({ key: "asset_class_weights", value: JSON.stringify(input) })
            .onDuplicateKeyUpdate({ set: { value: JSON.stringify(input) } });
          return { success: true, message: "Gewichte gespeichert" };
        } catch (err: any) {
          return { success: false, message: err?.message ?? "Unbekannter Fehler" };
        }
      }),

    /**
     * Ruft den internen /api/scheduled/signalScoreRefresh Endpoint auf.
     * Nützlich um nicht auf 07:00 UTC warten zu müssen.
     */
    triggerSignalScoreRefresh: adminProcedure.mutation(async () => {
      try {
        const { runSignalScoreRefresh } = await import("../scheduled/signalScoreRefreshScheduled");
        // D4 (Schnellaktionen-Audit): Fire-and-forget — der Job zieht intern
        // einen 2-Jahres-Preis-Backfill über alle Ticker und lief vorher
        // synchron in den Timeout.
        runSignalScoreRefresh()
          .then((result) => {
            if (result.ok) {
              console.log(`[triggerSignalScoreRefresh] Fertig: ${result.updated ?? 0} Scores, ${result.ytdRecalc?.updated ?? 0} YTD, ${result.backfill?.pricesImported ?? 0} Preise.`);
            } else {
              console.error(`[triggerSignalScoreRefresh] Fehler: ${result.error ?? "unbekannt"}`);
            }
          })
          .catch((e: any) => console.error("[triggerSignalScoreRefresh] Hintergrund-Fehler:", e?.message));
        return {
          success: true,
          message: "Score-Refresh gestartet — läuft im Hintergrund (inkl. YTD-Neuberechnung und Preis-Backfill; Server-Logs zeigen das Ergebnis).",
          details: null,
        };
      } catch (err: any) {
        return {
          success: false,
          message: `Fehler: ${err?.message ?? "Unbekannter Fehler"}`,
          details: null,
        };
      }
    }),

    /**
     * Manueller Trigger für den Signal-Cache-Cron (refreshSignalCache).
     * Berechnet qualityScore/momentumScore/combinedScore für alle Aktien neu
     * und speichert sie korrekt skaliert (0-100) in stock_signal_cache.
     */
    triggerSignalCacheRefresh: adminProcedure.mutation(async () => {
      try {
        const { refreshSignalCache } = await import('../cron/signalCacheCron');
        // D3 (Schnellaktionen-Audit): Fire-and-forget — vorher blockierte der
        // Call bis alle Aktien durch waren (Timeout-Risiko), obwohl die
        // Meldung «im Hintergrund» versprach.
        refreshSignalCache().catch((e: any) =>
          console.error('[triggerSignalCacheRefresh] Hintergrund-Fehler:', e?.message)
        );
        return {
          success: true,
          message: 'Signal-Cache-Refresh gestartet — läuft im Hintergrund (der 2-h-Cron hält die Scores danach aktuell).',
        };
      } catch (err: any) {
        return {
          success: false,
          message: `Fehler: ${err?.message ?? 'Unbekannter Fehler'}`,
        };
      }
    }),

    /**
     * Clear the in-memory quality metrics cache (forces fresh EODHD fetch on next request)
     */
    clearQualityMetricsCache: adminProcedure.mutation(async () => {
      const { clearQualityMetricsCache } = await import('../lib/qualityMetricsService');
      clearQualityMetricsCache();
      return { success: true, message: 'Quality-Metrics-Cache geleert. Nächste Anfrage holt frische Daten von EODHD.' };
    }),

    /**
     * Manually trigger the EODHD Gap-Filling job
     */
    triggerGapFilling: adminProcedure.mutation(async () => {
      const { runGapFilling } = await import("../cron/gapFillingCron");
      try {
        const result = await runGapFilling("manual");
        return {
          success: true,
          gapsFound: result.gapsFound,
          stocksAdded: result.stocksAdded,
          stocksSkipped: result.stocksSkipped,
          durationMs: result.durationMs,
        };
      } catch (err: any) {
        return {
          success: false,
          gapsFound: [],
          stocksAdded: [],
          stocksSkipped: 0,
          durationMs: 0,
          error: err?.message ?? "Unbekannter Fehler",
        };
      }
    }),

    /**
     * Get the last N gap-filling log entries
     */
    getGapFillLogs: adminProcedure
      .input(z.object({ limit: z.number().min(1).max(50).default(10) }))
      .query(async ({ input }) => {
        const { getDb } = await import("../db");
        const { gapFillLog } = await import("../../drizzle/schema");
        const { desc } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const rows = await db
          .select()
          .from(gapFillLog)
          .orderBy(desc(gapFillLog.runAt))
          .limit(input.limit);
        return rows;
      }),

    /**
     * Get the current Gap-Filling configuration (or defaults if not yet saved)
     */
    getGapFillConfig: adminProcedure.query(async () => {
      const { getDb } = await import("../db");
      const { gapFillConfig } = await import("../../drizzle/schema");
      const { desc } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const rows = await db.select().from(gapFillConfig).orderBy(desc(gapFillConfig.updatedAt)).limit(1);
      if (rows.length === 0) {
        // Return defaults
        return {
          id: null,
          minStocksPerSector: 3,
          minDividendStocks: 5,
          minDividendYield: 2,
          maxCandidatesPerGap: 3,
          maxStocksPerRun: 10,
          minMarketCapBillions: 0,
          targetSectors: [
            "Technology", "Healthcare", "Financial Services",
            "Consumer Cyclical", "Consumer Defensive", "Industrials",
            "Energy", "Utilities", "Real Estate",
            "Basic Materials", "Communication Services",
          ] as string[],
          allowedExchanges: [] as string[],
          enableRegionCheck: 0,
          minStocksPerRegion: 2,
          enableLowBetaCheck: 0,
          maxBetaForLowBeta: "0.8",
          minLowBetaStocks: 3,
          enableEsgCheck: 0,
          minEsgStocks: 2,
          updatedAt: new Date(),
        };
      }
      return rows[0];
    }),

    /**
     * Save / update the Gap-Filling configuration
     */
    updateGapFillConfig: adminProcedure
      .input(z.object({
        minStocksPerSector: z.number().int().min(1).max(20),
        minDividendStocks: z.number().int().min(0).max(50),
        minDividendYield: z.number().int().min(0).max(20),
        maxCandidatesPerGap: z.number().int().min(1).max(10),
        maxStocksPerRun: z.number().int().min(0).max(50),
        minMarketCapBillions: z.number().int().min(0).max(1000),
        targetSectors: z.array(z.string()).min(1).max(20),
        allowedExchanges: z.array(z.string()).max(20),
        enableRegionCheck: z.number().int().min(0).max(1),
        minStocksPerRegion: z.number().int().min(1).max(10),
        enableLowBetaCheck: z.number().int().min(0).max(1),
        maxBetaForLowBeta: z.string().max(10),
        minLowBetaStocks: z.number().int().min(1).max(20),
        enableEsgCheck: z.number().int().min(0).max(1),
        minEsgStocks: z.number().int().min(1).max(20),
      }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("../db");
        const { gapFillConfig } = await import("../../drizzle/schema");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        // Upsert: delete all and re-insert (single-row config pattern)
        await db.delete(gapFillConfig);
        await db.insert(gapFillConfig).values({
          minStocksPerSector: input.minStocksPerSector,
          minDividendStocks: input.minDividendStocks,
          minDividendYield: input.minDividendYield,
          maxCandidatesPerGap: input.maxCandidatesPerGap,
          maxStocksPerRun: input.maxStocksPerRun,
          minMarketCapBillions: input.minMarketCapBillions,
          targetSectors: input.targetSectors,
          allowedExchanges: input.allowedExchanges,
          enableRegionCheck: input.enableRegionCheck,
          minStocksPerRegion: input.minStocksPerRegion,
          enableLowBetaCheck: input.enableLowBetaCheck,
          maxBetaForLowBeta: input.maxBetaForLowBeta,
          minLowBetaStocks: input.minLowBetaStocks,
          enableEsgCheck: input.enableEsgCheck,
          minEsgStocks: input.minEsgStocks,
        });
        return { success: true };
      }),

    /**
     * List portfolio proposal logs (Multi-Agent KI-Analyse Resultate)
     * Nur im Admin-Bereich sichtbar — nicht für Endnutzer.
     */
    listProposalLogs: adminProcedure
      .input(z.object({
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
        confidence: z.enum(['hoch', 'mittel', 'niedrig']).optional(),
        meetsFilter: z.enum(['ja', 'nein', 'n/a']).optional(),
      }))
      .query(async ({ input }) => {
        const { getDb } = await import("../db");
        const { portfolioProposalLog } = await import("../../drizzle/schema");
        const { desc, eq, and, sql } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        const conditions: any[] = [];
        if (input.confidence) conditions.push(eq(portfolioProposalLog.overallConfidence, input.confidence));
        if (input.meetsFilter) conditions.push(eq(portfolioProposalLog.meetsKennzahlenFilter, input.meetsFilter));
        const rows = await db
          .select()
          .from(portfolioProposalLog)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(portfolioProposalLog.createdAt))
          .limit(input.limit)
          .offset(input.offset);
        const [countRow] = await db
          .select({ total: sql<number>`count(*)` })
          .from(portfolioProposalLog)
          .where(conditions.length > 0 ? and(...conditions) : undefined);
        return { rows, total: Number(countRow?.total ?? 0) };
      }),

    /**
     * Mark a proposal log as accepted/rejected (Nutzer-Feedback für Training)
     */
    updateProposalAccepted: adminProcedure
      .input(z.object({
        id: z.number(),
        accepted: z.enum(['ja', 'nein']),
      }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("../db");
        const { portfolioProposalLog } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");
        await db.update(portfolioProposalLog)
          .set({ accepted: input.accepted })
          .where(eq(portfolioProposalLog.id, input.id));
        return { success: true };
      }),

    /**
     * Admin: Vorschlag mit angepassten Positionen genehmigen und Portfolio erstellen.
     * Nimmt einen Proposal-Log-Eintrag + editierte Positionen und erstellt daraus
     * ein neues Portfolio für den ursprünglichen Nutzer.
     */
    approveProposalAndCreate: adminProcedure
      .input(z.object({
        proposalId: z.number(),
        portfolioName: z.string().min(1),
        investmentAmount: z.number().positive(),
        portfolioType: z.enum(['demo', 'live']).default('demo'),
        // Editierte Positionen (nach Admin-Review)
        positions: z.array(z.object({
          ticker: z.string(),
          companyName: z.string(),
          sector: z.string().optional(),
          currency: z.string().default('CHF'),
          currentPrice: z.number(),
          exchangeRateToChf: z.number().default(1),
          weightPct: z.number().min(0).max(100),
        })),
      }))
      .mutation(async ({ ctx, input }) => {
        const { getDb } = await import("../db");
        const { portfolioProposalLog } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        // 1) Proposal-Log laden um userId zu ermitteln
        const [proposal] = await db
          .select()
          .from(portfolioProposalLog)
          .where(eq(portfolioProposalLog.id, input.proposalId))
          .limit(1);
        if (!proposal) throw new Error(`Proposal #${input.proposalId} nicht gefunden`);

        // 2) Positionen normieren (Summe muss 100% ergeben)
        const totalWeight = input.positions.reduce((s, p) => s + p.weightPct, 0);
        if (totalWeight <= 0) throw new Error('Positionen haben Gesamtgewicht 0');
        const normalizedPositions = input.positions.map(p => ({
          ...p,
          weightPct: parseFloat(((p.weightPct / totalWeight) * 100).toFixed(2)),
        }));

        // 3) portfolioData im Format der portfolios.create-Mutation aufbauen
        // R-CHF-PRICE: avgBuyPriceCHF = currentPrice × exchangeRateToChf (Kaufzeitpunkt = jetzt)
        // Damit ist die Tag-1-Rendite exakt 0% — keine Verzerrung durch veraltete DB-Kurse.
        const portfolioData = {
          stocks: normalizedPositions.map(p => {
            const fxRate = p.exchangeRateToChf ?? 1;
            const priceCHF = (p.currentPrice ?? 0) * fxRate;
            return {
              ticker: p.ticker,
              companyName: p.companyName,
              sector: p.sector ?? 'Andere',
              currency: p.currency,
              currentPrice: p.currentPrice,
              exchangeRateToChf: fxRate,
              weight: p.weightPct,
              // Kaufpreis in CHF explizit setzen → Tag-1-Rendite = 0%
              avgBuyPrice: priceCHF,
              avgBuyPriceCHF: priceCHF,
            };
          }),
        };

        // 4) Portfolio über den bestehenden DB-Helper anlegen
        const { createSavedPortfolio } = await import("../db");
        const portfolioId = await createSavedPortfolio({
          userId: proposal.userId,
          name: input.portfolioName,
          description: `KI-Vorschlag #${input.proposalId} — vom Admin geprüft und genehmigt`,
          portfolioData: JSON.stringify(portfolioData),
          portfolioType: input.portfolioType,
          investmentAmount: String(input.investmentAmount),
          isAiOptimized: 1, // Portfolio wurde vom Admin aus KI-Vorschlag mit finalAdjustments erstellt
        });

        // 5) Training-Feedback berechnen: Differenz zwischen Original und Admin-Version
        const originalPositions = Array.isArray(proposal.positions) ? (proposal.positions as any[]) : [];
        const feedbackChanges: Array<{
          ticker: string;
          action: string;
          originalWeight: number;
          adminWeight: number;
          delta: number;
          replaced: boolean;
        }> = [];

        // Check for weight changes and removals
        for (const orig of originalPositions) {
          const adminPos = normalizedPositions.find(p => p.ticker.toUpperCase() === orig.ticker?.toUpperCase());
          if (!adminPos) {
            // Position removed by admin
            feedbackChanges.push({ ticker: orig.ticker, action: 'removed', originalWeight: parseFloat(orig.weightPct ?? orig.weight ?? '0'), adminWeight: 0, delta: -parseFloat(orig.weightPct ?? orig.weight ?? '0'), replaced: false });
          } else {
            const origW = parseFloat(orig.weightPct ?? orig.weight ?? '0');
            const adminW = adminPos.weightPct;
            const delta = adminW - origW;
            if (Math.abs(delta) > 0.5) {
              feedbackChanges.push({ ticker: orig.ticker, action: delta > 0 ? 'increased' : 'reduced', originalWeight: origW, adminWeight: adminW, delta, replaced: false });
            }
          }
        }
        // Check for new positions added by admin
        for (const adminPos of normalizedPositions) {
          const wasOriginal = originalPositions.find((p: any) => p.ticker?.toUpperCase() === adminPos.ticker.toUpperCase());
          if (!wasOriginal) {
            feedbackChanges.push({ ticker: adminPos.ticker, action: 'added', originalWeight: 0, adminWeight: adminPos.weightPct, delta: adminPos.weightPct, replaced: false });
          }
        }

        const adminFeedback = feedbackChanges.length > 0 ? {
          changes: feedbackChanges,
          summary: `Admin änderte ${feedbackChanges.length} Positionen: ${feedbackChanges.map(c => `${c.ticker} ${c.action} (${c.delta > 0 ? '+' : ''}${c.delta.toFixed(1)}%)`).join(', ')}`,
          approvedAt: new Date().toISOString(),
          adminId: ctx.user.id,
        } : null;

        // 5) Proposal als übernommen markieren + Feedback speichern
        await db.update(portfolioProposalLog)
          .set({ accepted: 'ja', ...(adminFeedback ? { adminFeedback } : {}) })
          .where(eq(portfolioProposalLog.id, input.proposalId));

        if (feedbackChanges.length > 0) {
          console.log(`[admin.approveProposalAndCreate] Training feedback saved: ${feedbackChanges.length} changes for proposal #${input.proposalId}`);
        }

        console.log(`[admin.approveProposalAndCreate] Portfolio ${portfolioId} created for user ${proposal.userId} from proposal #${input.proposalId}`);

        // 6) Automatischen Backfill für neue Symbole anstoßen (fire-and-forget)
        try {
          const tickers = normalizedPositions.map(p => p.ticker).filter(Boolean);
          if (tickers.length > 0) {
            console.log(`[admin.approveProposalAndCreate] Triggering auto-backfill for ${tickers.length} symbols: ${tickers.join(',')}`);
            import("../autoBackfill").then(({ autoBackfillNewSymbols }) => {
              autoBackfillNewSymbols(tickers).then(result => {
                if (result.newSymbolsDetected > 0) {
                  console.log(`[admin.approveProposalAndCreate] Auto-backfill completed: ${result.newSymbolsDetected} new symbols processed`);
                }
              }).catch(err => {
                console.error(`[admin.approveProposalAndCreate] Auto-backfill error:`, err);
              });
            });
          }
        } catch (backfillErr) {
          console.warn('[admin.approveProposalAndCreate] Backfill trigger failed (non-blocking):', backfillErr);
        }

        // 7) Nutzer per E-Mail benachrichtigen (nicht-blockierend)
        let userEmailSent = false;
        let ownerNotificationSent = false;
        let noEmailOnFile = false;
        try {
          const { getUserById } = await import("../db");
          const { sendEmail } = await import("../_core/email");
          const { notifyOwner } = await import("../_core/notification");
          const targetUser = await getUserById(proposal.userId);
          const appUrl = process.env.VITE_APP_URL || 'https://portfoliodash-aqvizp6n.manus.space';
          const positionCount = normalizedPositions.length;
          const topPositions = [...normalizedPositions]
            .sort((a, b) => b.weightPct - a.weightPct)
            .slice(0, 5)
            .map(p => `${p.ticker} (${p.weightPct.toFixed(1)}%)`);
          if (targetUser?.email) {
            userEmailSent = await sendEmail({
              to: targetUser.email,
              subject: `Ihr KI-Portfolio «${input.portfolioName}» ist bereit`,
              html: `
<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:40px 20px;">
  <div style="max-width:600px;margin:0 auto;background:#1e293b;border-radius:12px;padding:40px;">
    <h1 style="color:#14b8a6;font-size:24px;margin:0 0 8px;">Portfolio bereit ✓</h1>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Ihr KI-generiertes Portfolio wurde vom Administrator geprüft und genehmigt.</p>
    <div style="background:#0f172a;border-radius:8px;padding:20px;margin-bottom:24px;">
      <div style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:4px;">«${input.portfolioName}»</div>
      <div style="color:#64748b;font-size:13px;">${positionCount} Positionen · ${input.portfolioType === 'live' ? 'Live-Portfolio' : 'Demo-Portfolio'} · CHF ${input.investmentAmount.toLocaleString('de-CH')}</div>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0 0 8px;">Top-Positionen:</p>
    <p style="color:#e2e8f0;font-size:14px;font-family:monospace;margin:0 0 24px;">${topPositions.join(' · ')}</p>
    <a href="${appUrl}/portfolios" style="display:inline-block;padding:12px 28px;background:#14b8a6;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Portfolio ansehen →</a>
    <p style="color:#475569;font-size:12px;margin:32px 0 0;">Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht auf diese E-Mail.</p>
  </div>
</body></html>`,
            });
            if (userEmailSent) console.log(`[admin.approveProposalAndCreate] Email sent to ${targetUser.email}`);
          } else {
            noEmailOnFile = true;
            console.log(`[admin.approveProposalAndCreate] No email on file for user ${proposal.userId}`);
          }
          // Owner-Benachrichtigung
          ownerNotificationSent = await notifyOwner({
            title: `Admin: Portfolio «${input.portfolioName}» erstellt`,
            content: `Portfolio #${portfolioId} für Nutzer ${targetUser?.name ?? proposal.userId} (${positionCount} Titel, CHF ${input.investmentAmount.toLocaleString('de-CH')}) wurde aus KI-Vorschlag #${input.proposalId} genehmigt.`,
          }).catch(() => false);
        } catch (notifyErr) {
          console.warn('[admin.approveProposalAndCreate] Notification failed (non-blocking):', notifyErr);
        }

        return { success: true, portfolioId, userEmailSent, ownerNotificationSent, noEmailOnFile };
      }),

    // ─── Feedback-Dashboard: Aggregierte adminFeedback-Signale ───────────────
    getFeedbackStats: adminProcedure.query(async () => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) throw new Error('DB not available');
      const { portfolioProposalLog } = await import('../../drizzle/schema');
      const { isNotNull, desc } = await import('drizzle-orm');

      const rows = await db.select({
        id: portfolioProposalLog.id,
        adminFeedback: portfolioProposalLog.adminFeedback,
        createdAt: portfolioProposalLog.createdAt,
        riskProfile: portfolioProposalLog.riskProfile,
      }).from(portfolioProposalLog)
        .where(isNotNull(portfolioProposalLog.adminFeedback))
        .orderBy(desc(portfolioProposalLog.createdAt))
        .limit(50);

      const tickerActions: Record<string, { reduce: number; increase: number; replace: number; remove: number; add: number; total: number; lastSeen: Date }> = {};

      for (const row of rows) {
        const fb = row.adminFeedback as any;
        if (!fb) continue;
        const entries: Array<{ ticker: string; action: string }> = [
          ...(fb.reduced ?? []).map((t: string) => ({ ticker: t, action: 'reduce' })),
          ...(fb.increased ?? []).map((t: string) => ({ ticker: t, action: 'increase' })),
          ...(fb.replaced ?? []).map((t: string) => ({ ticker: t, action: 'replace' })),
          ...(fb.removed ?? []).map((t: string) => ({ ticker: t, action: 'remove' })),
          ...(fb.added ?? []).map((t: string) => ({ ticker: t, action: 'add' })),
        ];
        for (const e of entries) {
          if (!tickerActions[e.ticker]) tickerActions[e.ticker] = { reduce: 0, increase: 0, replace: 0, remove: 0, add: 0, total: 0, lastSeen: row.createdAt };
          (tickerActions[e.ticker] as any)[e.action]++;
          tickerActions[e.ticker].total++;
          if (row.createdAt > tickerActions[e.ticker].lastSeen) tickerActions[e.ticker].lastSeen = row.createdAt;
        }
      }

      const patterns = Object.entries(tickerActions)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([ticker, v]) => ({
          ticker,
          reduce: v.reduce,
          increase: v.increase,
          replace: v.replace,
          remove: v.remove,
          add: v.add,
          total: v.total,
          lastSeen: v.lastSeen,
          dominantAction: (['reduce', 'increase', 'replace', 'remove', 'add'] as Array<'reduce' | 'increase' | 'replace' | 'remove' | 'add'>)
            .sort((a, b) => v[b] - v[a])[0],
        }));

      return {
        totalFeedbackEntries: rows.length,
        patterns,
        recentFeedback: rows.slice(0, 10).map(r => ({
          id: r.id,
          createdAt: r.createdAt,
          riskProfile: r.riskProfile,
          summary: r.adminFeedback as any,
        })),
      };
    }),

  // Admin-Review Workflow: save reviewed positions + comments
  saveAdminReview: adminProcedure
    .input(z.object({
      proposalId: z.number(),
      reviewedPositions: z.array(z.object({
        ticker: z.string(),
        companyName: z.string().optional(),
        sector: z.string().optional(),
        currency: z.string().optional(),
        weightPct: z.number(),
        originalWeightPct: z.number().optional(),
        aiReason: z.string().optional(),
        // Multi-Asset-/Anzeige-Felder — müssen den Review-Roundtrip überleben,
        // sonst fallen ETF-/Sleeve-Positionen im Wizard auf «Aktie, Note F» zurück.
        assetType: z.string().optional(),
        assetClass: z.string().optional(),
        combinedScore: z.number().nullable().optional(),
        signal: z.string().optional(),
        currentPrice: z.number().optional(),
        exchangeRateToChf: z.number().optional(),
      })),
      adminComments: z.record(z.string(), z.string()).optional(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { portfolioProposalLog } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });

      const totalWeight = input.reviewedPositions.reduce((s, p) => s + p.weightPct, 0);
      const normalizedPositions = totalWeight > 0
        ? input.reviewedPositions.map(p => ({ ...p, weightPct: Math.round(p.weightPct / totalWeight * 100 * 10) / 10 }))
        : input.reviewedPositions;

      await db.update(portfolioProposalLog)
        .set({
          adminReviewedPositions: normalizedPositions as any,
          adminComments: (input.adminComments ?? {}) as any,
          reviewStatus: 'reviewed',
          reviewedAt: new Date(),
        })
        .where(eq(portfolioProposalLog.id, input.proposalId));

      return { success: true, proposalId: input.proposalId };
    }),

  /**
   * Refresh EODHD sectors for all stocks in the DB
   * Fixes sector classification discrepancy between Positionen tab and Deep Dive
   */
  refreshSectors: adminProcedure.mutation(async () => {
    const { getDb } = await import('../db');
    const { stocks: stocksTable } = await import('../../drizzle/schema');
    const { fetchEODHDFundamentals } = await import('../_core/eodhdApi');
    const db = await getDb();
    if (!db) return { success: false, message: 'DB not available' };
    const allStocks = await db.select({ id: stocksTable.id, ticker: stocksTable.ticker }).from(stocksTable).limit(500);

    // D2 (Schnellaktionen-Audit): Fire-and-forget — die Schleife läuft
    // ~500 Titel × EODHD-Latenz und lief vorher synchron in den Timeout.
    // Fehler werden geloggt statt still geschluckt.
    (async () => {
      let updated = 0;
      const batchSize = 5;
      for (let i = 0; i < allStocks.length; i += batchSize) {
        const batch = allStocks.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (s) => {
          try {
            const f = await fetchEODHDFundamentals(s.ticker);
            if (f.sector) {
              const { eq } = await import('drizzle-orm');
              await db.update(stocksTable).set({ sector: f.sector }).where(eq(stocksTable.id, s.id));
              updated++;
            }
          } catch (e: any) {
            console.warn(`[refreshSectors] ${s.ticker}: ${e?.message ?? e}`);
          }
        }));
        if (i + batchSize < allStocks.length) await new Promise(r => setTimeout(r, 200));
      }
      console.log(`[refreshSectors] Fertig: ${updated} von ${allStocks.length} Aktien mit EODHD-Sektoren aktualisiert.`);
    })().catch((e: any) => console.error('[refreshSectors] Hintergrund-Fehler:', e?.message));

    return {
      success: true,
      message: `Sektoren-Aktualisierung für ${allStocks.length} Aktien gestartet — läuft im Hintergrund (Server-Logs zeigen das Ergebnis).`,
    };
  }),

  /**
   * Trigger portfolio metrics snapshot (backfill or daily)
   */
  triggerPortfolioMetricsSnapshot: adminProcedure
    .input(z.object({ backfill: z.boolean().default(false), recompute: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const { handlePortfolioMetricsSnapshot } = await import('../scheduled/portfolioMetricsSnapshotScheduled');
      // D1 (Schnellaktionen-Audit): Backfill heisst NEU berechnen — ohne
      // recompute prallte ein erneuter Lauf an der Dedupe-Logik ab und
      // unbrauchbare Alt-Snapshots blieben für immer stehen.
      const recompute = input.recompute ?? input.backfill;
      const mockReq = {
        query: { backfill: input.backfill ? 'true' : 'false', recompute: recompute ? 'true' : 'false' },
        body: { backfill: input.backfill, recompute },
      } as any;
      // Fire-and-forget: return immediately so the browser doesn't time out.
      // Backfill for 37 portfolios × 365 days can take 2-3 minutes.
      const mockRes = {
        json: (_data: any) => mockRes,
        status: (_code: number) => ({ json: (_data: any) => mockRes }),
      } as any;
      handlePortfolioMetricsSnapshot(mockReq, mockRes).catch((err: any) => {
        console.error('[triggerPortfolioMetricsSnapshot] Background error:', err?.message);
      });
      return {
        ok: true,
        started: true,
        message: input.backfill
          ? 'Backfill gestartet — läuft im Hintergrund (~1-3 Min). Server-Logs zeigen den Fortschritt.'
          : 'Snapshot gestartet — läuft im Hintergrund.',
      };
    }),

  /**
   * K9 (Learning-Koordination): Erfolgsbilanz der Auto-Portfolio-Vorschläge —
   * realisierter 30-Tage-Return (CHF) vs. SMI, gemessen vom wöchentlichen
   * learningCron (So 05:00 UTC). Reine Transparenz, keine Auto-Anpassung.
   */
  getProposalOutcomes: adminProcedure.query(async () => {
    const { getDb } = await import("../db");
    const { portfolioProposalLog } = await import("../../drizzle/schema");
    const { isNotNull, desc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
    const rows = await db
      .select({
        id: portfolioProposalLog.id,
        createdAt: portfolioProposalLog.createdAt,
        method: portfolioProposalLog.method,
        qualityTier: portfolioProposalLog.qualityTier,
        accepted: portfolioProposalLog.accepted,
        expectedReturnPct: portfolioProposalLog.expectedReturnPct,
        realizedReturn30dPct: portfolioProposalLog.realizedReturn30dPct,
        benchmarkReturn30dPct: portfolioProposalLog.benchmarkReturn30dPct,
        realizedAlpha30dPct: portfolioProposalLog.realizedAlpha30dPct,
        outcomeCoveragePct: portfolioProposalLog.outcomeCoveragePct,
      })
      .from(portfolioProposalLog)
      .where(isNotNull(portfolioProposalLog.realizedAlpha30dPct))
      .orderBy(desc(portfolioProposalLog.createdAt))
      .limit(100);
    const alphas = rows
      .map((r) => parseFloat(String(r.realizedAlpha30dPct)))
      .filter((v) => Number.isFinite(v));
    return {
      evaluatedCount: alphas.length,
      avgAlphaPct: alphas.length ? Math.round((alphas.reduce((s, v) => s + v, 0) / alphas.length) * 100) / 100 : null,
      hitRatePct: alphas.length ? Math.round((alphas.filter((v) => v > 0).length / alphas.length) * 1000) / 10 : null,
      recent: rows.slice(0, 20),
    };
  }),

  /** K9: Erfolgsmessung sofort anstossen (statt auf So 05:00 zu warten). */
  triggerProposalOutcomeEvaluation: adminProcedure.mutation(async () => {
    const { evaluateProposalOutcomes } = await import("../analytics/proposalOutcome");
    const res = await evaluateProposalOutcomes();
    return {
      success: true,
      message: `${res.evaluated} Vorschläge bewertet, ${res.skipped} übersprungen${res.reason ? ` (${res.reason})` : ""}.`,
    };
  }),

  /**
   * K9-Nachtrag: Migration 0034 remote anwenden. Der manus-Deploy führt
   * `pnpm db:push` nicht aus, und DATABASE_URL existiert nur zur Laufzeit im
   * Deploy — darum wendet dieser Admin-Endpoint die (rein additiven) Spalten
   * von `drizzle/0034_youthful_namorita.sql` idempotent an und trägt den
   * Drizzle-Journal-Eintrag nach, damit ein späteres echtes `drizzle-kit
   * migrate` 0034 nicht erneut anwendet (Hash/Zeitstempel aus dem Repo).
   */
  applyMigration0034: adminProcedure.mutation(async () => {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

    // Spaltendefinitionen exakt wie in 0034_youthful_namorita.sql
    const COLUMNS: Array<{ name: string; ddl: string }> = [
      { name: "realizedReturn30dPct", ddl: "ADD `realizedReturn30dPct` decimal(8,2)" },
      { name: "benchmarkReturn30dPct", ddl: "ADD `benchmarkReturn30dPct` decimal(8,2)" },
      { name: "realizedAlpha30dPct", ddl: "ADD `realizedAlpha30dPct` decimal(8,2)" },
      { name: "outcomeCoveragePct", ddl: "ADD `outcomeCoveragePct` decimal(6,2)" },
      { name: "outcomeEvaluatedAt", ddl: "ADD `outcomeEvaluatedAt` timestamp" },
    ];

    const added: string[] = [];
    const present: string[] = [];
    for (const col of COLUMNS) {
      const res = await db.execute(sql`
        SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'portfolioProposalLog'
          AND COLUMN_NAME = ${col.name}
      `);
      const cnt = Number((res as any)[0]?.[0]?.cnt ?? 0);
      if (cnt > 0) {
        present.push(col.name);
      } else {
        await db.execute(sql.raw(`ALTER TABLE \`portfolioProposalLog\` ${col.ddl}`));
        added.push(col.name);
      }
    }

    // Journal nachtragen (Werte entsprechen drizzle/meta/_journal.json Eintrag 34
    // und sha256 der Migrationsdatei — siehe drizzle-orm readMigrationFiles).
    const HASH = "5b0a81f9ca4bd6184cd04c44318a332e78bf9cb67af9e329f42c0d3dbe7e0b0c";
    const FOLDER_MILLIS = 1784280450431;
    let journal = "unverändert";
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    const jRes = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM \`__drizzle_migrations\` WHERE created_at = ${FOLDER_MILLIS}
    `);
    if (Number((jRes as any)[0]?.[0]?.cnt ?? 0) === 0) {
      await db.execute(sql`
        INSERT INTO \`__drizzle_migrations\` (\`hash\`, \`created_at\`) VALUES (${HASH}, ${FOLDER_MILLIS})
      `);
      journal = "Eintrag 0034 nachgetragen";
    }

    return {
      success: true,
      added,
      alreadyPresent: present,
      journal,
    };
  }),

  /**
   * Migration 0033 (algo_backtest_runs / _portfolios / algo_tuning_log) idempotent
   * anwenden. Wie applyMigration0034: der manus-Deploy führt `drizzle-kit migrate`
   * nicht aus, weshalb diese Tabellen in Prod fehlen können → die Algo-Backtest-
   * Seite bleibt leer. CREATE TABLE IF NOT EXISTS + Index-Existenzcheck sind sicher
   * wiederholbar. Ausserdem wird der Journal-Eintrag nachgetragen.
   */
  applyMigration0033: adminProcedure.mutation(async () => {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

    // Tabellen exakt wie in 0033_chief_romulus.sql, aber IF NOT EXISTS.
    const TABLES: Array<{ name: string; ddl: string }> = [
      { name: "algo_backtest_portfolios", ddl: `CREATE TABLE IF NOT EXISTS \`algo_backtest_portfolios\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`runId\` int NOT NULL,
        \`riskProfile\` varchar(32) NOT NULL,
        \`goal\` varchar(32) NOT NULL,
        \`positionsSnapshot\` text NOT NULL,
        \`proposalMetrics\` text,
        \`appliedSectorTilts\` text,
        \`appliedFactorTilts\` text,
        \`challengerCritique\` text,
        \`synthesizerRecommendation\` text,
        \`actualPerf30dPct\` decimal(8,4),
        \`actualSharpe30d\` decimal(8,4),
        \`actualVolatility30d\` decimal(8,4),
        \`actualMaxDrawdown30d\` decimal(8,4),
        \`benchmarkPerf30dPct\` decimal(8,4),
        \`alpha30dPct\` decimal(8,4),
        \`portfolioAnalysis\` text,
        \`creationError\` text,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`algo_backtest_portfolios_id\` PRIMARY KEY(\`id\`)
      )` },
      { name: "algo_backtest_runs", ddl: `CREATE TABLE IF NOT EXISTS \`algo_backtest_runs\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`runMonth\` date NOT NULL,
        \`status\` varchar(32) NOT NULL DEFAULT 'creating',
        \`algoVersion\` varchar(64),
        \`marktHubSnapshot\` text,
        \`sectorTiltsSnapshot\` text,
        \`leadingFactor\` varchar(64),
        \`marktRegime\` varchar(64),
        \`llmAnalysis\` text,
        \`avgPerf30dPct\` decimal(8,4),
        \`benchmarkPerf30dPct\` decimal(8,4),
        \`portfolioCount\` int DEFAULT 0,
        \`evaluatedAt\` timestamp,
        \`errorDetails\` text,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`algo_backtest_runs_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`algo_backtest_runs_runMonth_unique\` UNIQUE(\`runMonth\`)
      )` },
      { name: "algo_tuning_log", ddl: `CREATE TABLE IF NOT EXISTS \`algo_tuning_log\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`triggeredByRunId\` int,
        \`fromVersion\` varchar(64),
        \`toVersion\` varchar(64),
        \`parameterChanged\` varchar(128) NOT NULL,
        \`oldValue\` varchar(256),
        \`newValue\` varchar(256),
        \`rationale\` text NOT NULL,
        \`overfittingRisk\` varchar(16) DEFAULT 'low',
        \`expectedImpact\` text,
        \`actualImpact\` text,
        \`reverted\` int DEFAULT 0,
        \`source\` varchar(32) DEFAULT 'llm_auto',
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`algo_tuning_log_id\` PRIMARY KEY(\`id\`)
      )` },
    ];

    const createdTables: string[] = [];
    for (const t of TABLES) {
      const res = await db.execute(sql`
        SELECT COUNT(*) AS cnt FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t.name}
      `);
      const existedBefore = Number((res as any)[0]?.[0]?.cnt ?? 0) > 0;
      await db.execute(sql.raw(t.ddl));
      if (!existedBefore) createdTables.push(t.name);
    }

    // Indizes (MySQL kennt kein IF NOT EXISTS für Indizes → über STATISTICS prüfen).
    const INDEXES: Array<{ table: string; index: string; ddl: string }> = [
      { table: "algo_backtest_portfolios", index: "idx_abp_run_profile", ddl: "CREATE INDEX `idx_abp_run_profile` ON `algo_backtest_portfolios` (`runId`,`riskProfile`,`goal`)" },
      { table: "algo_backtest_runs", index: "idx_abt_runs_status", ddl: "CREATE INDEX `idx_abt_runs_status` ON `algo_backtest_runs` (`status`)" },
      { table: "algo_tuning_log", index: "idx_atl_run", ddl: "CREATE INDEX `idx_atl_run` ON `algo_tuning_log` (`triggeredByRunId`)" },
    ];
    const createdIndexes: string[] = [];
    for (const ix of INDEXES) {
      const res = await db.execute(sql`
        SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${ix.table} AND INDEX_NAME = ${ix.index}
      `);
      if (Number((res as any)[0]?.[0]?.cnt ?? 0) === 0) {
        try {
          await db.execute(sql.raw(ix.ddl));
          createdIndexes.push(ix.index);
        } catch (e) {
          console.warn(`[applyMigration0033] Index ${ix.index} konnte nicht erstellt werden:`, (e as Error).message);
        }
      }
    }

    // Journal-Eintrag 0033 nachtragen (sha256 der Migrationsdatei + _journal.when).
    const HASH = "db9fba011344a5045b55b6a200784194a99ea6f06508f7a8d2015ffef1576c4c";
    const FOLDER_MILLIS = 1784273092304;
    let journal = "unverändert";
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    const jRes = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM \`__drizzle_migrations\` WHERE created_at = ${FOLDER_MILLIS}
    `);
    if (Number((jRes as any)[0]?.[0]?.cnt ?? 0) === 0) {
      await db.execute(sql`
        INSERT INTO \`__drizzle_migrations\` (\`hash\`, \`created_at\`) VALUES (${HASH}, ${FOLDER_MILLIS})
      `);
      journal = "Eintrag 0033 nachgetragen";
    }

    return { success: true, createdTables, createdIndexes, journal };
  }),

  // Get a single proposal by ID (for deep-link from wizard)
  getProposalById: adminProcedure
    .input(z.object({ proposalId: z.number() }))
    .query(async ({ input }) => {
      const { getDb } = await import("../db");
      const { portfolioProposalLog } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
      const rows = await db.select().from(portfolioProposalLog)
        .where(eq(portfolioProposalLog.id, input.proposalId))
        .limit(1);
      if (rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal nicht gefunden' });
      return rows[0];
    }),

  // === UNIVERSE EXPANSION CANDIDATES ===
  getUniverseCandidates: adminProcedure.query(async () => {
    const { getDb } = await import("../db");
    const { stocks } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(stocks)
      .where(eq(stocks.source, "ai_recommended"))
      .orderBy(stocks.createdAt);
    return rows.filter((r: any) => String(r.notes ?? "").startsWith("universe_expansion"));
  }),

  approveUniverseCandidate: adminProcedure
    .input(z.object({ stockId: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { stocks } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });

      // Ticker laden um Preis zu beziehen
      const [row] = await db.select({ ticker: stocks.ticker, currency: stocks.currency, currentPrice: stocks.currentPrice }).from(stocks).where(eq(stocks.id, input.stockId)).limit(1);

      // Preis via EODHD laden falls noch nicht vorhanden
      const priceUpdate: Record<string, unknown> = { source: "manual", notes: null, listType: "watchlist" };
      if (row && (!row.currentPrice || row.currentPrice === '0')) {
        try {
          const { ENV } = await import('../_core/env');
          if (ENV.eodhdApiKey) {
            const eoTicker = row.ticker.includes('.') ? row.ticker : `${row.ticker}.US`;
            const resp = await fetch(`https://eodhd.com/api/real-time/${eoTicker}?api_token=${ENV.eodhdApiKey}&fmt=json`);
            if (resp.ok) {
              const data: any = await resp.json();
              const price = parseFloat(data?.close ?? data?.adjusted_close ?? '0');
              if (price > 0) {
                priceUpdate.currentPrice = String(price);
                // FX-Rate: für CHF-Aktien 1, für andere aus EODHD oder Standard
                const currency = (row.currency ?? 'USD').toUpperCase();
                if (currency !== 'CHF') {
                  // Lade CHF-Kurs aus DB (andere Aktie mit gleicher Währung)
                  const fxRow = await db.select({ exchangeRateToChf: stocks.exchangeRateToChf })
                    .from(stocks)
                    .where(eq(stocks.currency, currency))
                    .limit(1);
                  if (fxRow[0]?.exchangeRateToChf) priceUpdate.exchangeRateToChf = fxRow[0].exchangeRateToChf;
                } else {
                  priceUpdate.exchangeRateToChf = '1';
                }
                console.log(`[approveUniverseCandidate] Fetched price for ${row.ticker}: ${price} ${currency}`);
              }
            }
          }
        } catch (e) {
          console.warn(`[approveUniverseCandidate] Price fetch failed for ${row?.ticker}:`, e);
        }
      }

      await db.update(stocks).set(priceUpdate).where(eq(stocks.id, input.stockId));
      return { success: true, priceLoaded: !!priceUpdate.currentPrice };
    }),

  rejectUniverseCandidate: adminProcedure
    .input(z.object({ stockId: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { stocks } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
      await db.delete(stocks).where(eq(stocks.id, input.stockId));
      return { success: true };
    }),

  approveAllUniverseCandidates: adminProcedure.mutation(async () => {
    const { getDb } = await import("../db");
    const { stocks } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { ENV } = await import('../_core/env');
    const db = await getDb();
    if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
    const rows = await db
      .select({ id: stocks.id, notes: stocks.notes, ticker: stocks.ticker, currency: stocks.currency, currentPrice: stocks.currentPrice })
      .from(stocks)
      .where(eq(stocks.source, "ai_recommended"));
    const candidates = rows.filter((r: any) => String(r.notes ?? "").startsWith("universe_expansion"));
    let pricesFetched = 0;
    for (const c of candidates) {
      const updateSet: Record<string, unknown> = { source: "manual", notes: null, listType: "watchlist" };
      // Preis laden falls fehlend
      if ((!c.currentPrice || c.currentPrice === '0') && ENV.eodhdApiKey) {
        try {
          const eoTicker = c.ticker.includes('.') ? c.ticker : `${c.ticker}.US`;
          const resp = await fetch(`https://eodhd.com/api/real-time/${eoTicker}?api_token=${ENV.eodhdApiKey}&fmt=json`);
          if (resp.ok) {
            const data: any = await resp.json();
            const price = parseFloat(data?.close ?? data?.adjusted_close ?? '0');
            if (price > 0) {
              updateSet.currentPrice = String(price);
              const currency = (c.currency ?? 'USD').toUpperCase();
              if (currency !== 'CHF') {
                const fxRow = await db.select({ exchangeRateToChf: stocks.exchangeRateToChf }).from(stocks).where(eq(stocks.currency, currency)).limit(1);
                if (fxRow[0]?.exchangeRateToChf) updateSet.exchangeRateToChf = fxRow[0].exchangeRateToChf;
              } else {
                updateSet.exchangeRateToChf = '1';
              }
              pricesFetched++;
            }
          }
        } catch (e) {
          console.warn(`[approveAll] Price fetch failed for ${c.ticker}:`, e);
        }
      }
      await db.update(stocks).set(updateSet).where(eq(stocks.id, c.id));
    }
    return { success: true, approved: candidates.length, pricesFetched };
  }),

  // ─────────────────────────────────────────────────────────────────────────────
  // CATEGORIES CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  listCategories: adminProcedure.query(async () => {
    const { getDb } = await import("../db");
    const { categories } = await import("../../drizzle/schema");
    const { asc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db.select().from(categories).orderBy(asc(categories.name));
  }),

  createCategory: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      color: z.string().max(20).optional(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { categories } = await import("../../drizzle/schema");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.insert(categories).values({
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
      });
      return { success: true };
    }),

  updateCategory: adminProcedure
    .input(z.object({
      id: z.number().int(),
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      color: z.string().max(20).optional(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { categories } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.update(categories).set({
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
      }).where(eq(categories.id, input.id));
      return { success: true };
    }),

  deleteCategory: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { categories } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.delete(categories).where(eq(categories.id, input.id));
      return { success: true };
    }),

  /** Count how many stocks use a given category name */
  getCategoryStockCount: adminProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("../db");
      const { stocks } = await import("../../drizzle/schema");
      const { eq, count } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { count: 0 };
      const result = await db.select({ cnt: count() }).from(stocks).where(eq(stocks.category, input.name));
      return { count: result[0]?.cnt ?? 0 };
    }),

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTORS CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  listSectors: adminProcedure.query(async () => {
    const { getDb } = await import("../db");
    const { sectors } = await import("../../drizzle/schema");
    const { asc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return db.select().from(sectors).orderBy(asc(sectors.sortOrder), asc(sectors.name));
  }),

  createSector: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      color: z.string().max(20).optional(),
      icon: z.string().max(50).optional(),
      includeInGapFilling: z.number().int().min(0).max(1).default(1),
      sortOrder: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { sectors } = await import("../../drizzle/schema");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.insert(sectors).values({
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
        icon: input.icon ?? null,
        includeInGapFilling: input.includeInGapFilling,
        sortOrder: input.sortOrder,
      });
      return { success: true };
    }),

  updateSector: adminProcedure
    .input(z.object({
      id: z.number().int(),
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      color: z.string().max(20).optional(),
      icon: z.string().max(50).optional(),
      includeInGapFilling: z.number().int().min(0).max(1),
      sortOrder: z.number().int().min(0),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { sectors } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.update(sectors).set({
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
        icon: input.icon ?? null,
        includeInGapFilling: input.includeInGapFilling,
        sortOrder: input.sortOrder,
      }).where(eq(sectors.id, input.id));
      return { success: true };
    }),

  deleteSector: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { sectors } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.delete(sectors).where(eq(sectors.id, input.id));
      return { success: true };
    }),

  /** Count how many stocks use a given sector name */
  getSectorStockCount: adminProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("../db");
      const { stocks } = await import("../../drizzle/schema");
      const { eq, count } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { count: 0 };
      const result = await db.select({ cnt: count() }).from(stocks).where(eq(stocks.sector, input.name));
      return { count: result[0]?.cnt ?? 0 };
    }),

  /** Seed default GICS sectors if the sectors table is empty */
  seedDefaultSectors: adminProcedure.mutation(async () => {
    const { getDb } = await import("../db");
    const { sectors } = await import("../../drizzle/schema");
    const { count } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const existing = await db.select({ cnt: count() }).from(sectors);
    if ((existing[0]?.cnt ?? 0) > 0) return { success: true, seeded: 0 };
    const defaults = [
      { name: "Technology", description: "Technologie-Unternehmen (Software, Hardware, Halbleiter)", color: "#3b82f6", icon: "💻", sortOrder: 1 },
      { name: "Healthcare", description: "Gesundheitswesen (Pharma, Medtech, Biotech)", color: "#10b981", icon: "🏥", sortOrder: 2 },
      { name: "Financial Services", description: "Finanzdienstleistungen (Banken, Versicherungen, Asset Management)", color: "#f59e0b", icon: "🏦", sortOrder: 3 },
      { name: "Consumer Cyclical", description: "Zyklischer Konsum (Automobil, Retail, Tourismus)", color: "#8b5cf6", icon: "🛒", sortOrder: 4 },
      { name: "Consumer Defensive", description: "Defensiver Konsum (Lebensmittel, Getränke, Haushalt)", color: "#06b6d4", icon: "🛍️", sortOrder: 5 },
      { name: "Industrials", description: "Industrie (Maschinenbau, Logistik, Rüstung)", color: "#64748b", icon: "🏭", sortOrder: 6 },
      { name: "Energy", description: "Energie (Öl, Gas, Erneuerbare)", color: "#f97316", icon: "⚡", sortOrder: 7 },
      { name: "Utilities", description: "Versorger (Strom, Wasser, Gas)", color: "#84cc16", icon: "💡", sortOrder: 8 },
      { name: "Real Estate", description: "Immobilien (REITs, Immobilienentwickler)", color: "#ec4899", icon: "🏢", sortOrder: 9 },
      { name: "Basic Materials", description: "Grundstoffe (Bergbau, Chemie, Stahl)", color: "#a16207", icon: "⛏️", sortOrder: 10 },
      { name: "Communication Services", description: "Kommunikation (Telekom, Medien, Internet)", color: "#7c3aed", icon: "📡", sortOrder: 11 },
    ];
    await db.insert(sectors).values(defaults.map(d => ({ ...d, includeInGapFilling: 1 })));
    return { success: true, seeded: defaults.length };
  }),

  /** Seed default categories if the categories table is empty */
  seedDefaultCategories: adminProcedure.mutation(async () => {
    const { getDb } = await import("../db");
    const { categories } = await import("../../drizzle/schema");
    const { count } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const existing = await db.select({ cnt: count() }).from(categories);
    if ((existing[0]?.cnt ?? 0) > 0) return { success: true, seeded: 0 };
    const defaults = [
      { name: "Dividendenaktien", description: "Aktien mit regelmässigen Dividendenausschüttungen", color: "#10b981" },
      { name: "Wachstumsaktien", description: "Aktien mit hohem Wachstumspotenzial", color: "#3b82f6" },
      { name: "Value-Aktien", description: "Unterbewertete Aktien mit solidem Fundament", color: "#f59e0b" },
      { name: "ETF", description: "Exchange Traded Funds", color: "#8b5cf6" },
      { name: "Defensiv", description: "Defensive Titel mit niedrigem Beta", color: "#64748b" },
      { name: "Small Cap", description: "Kleinkapitalisierte Unternehmen", color: "#ec4899" },
      { name: "Mid Cap", description: "Mittelkapitalisierte Unternehmen", color: "#06b6d4" },
      { name: "Large Cap", description: "Grosskapitalisierte Blue-Chip-Unternehmen", color: "#f97316" },
      { name: "Rohstoffe", description: "Rohstoff-bezogene Titel und ETFs", color: "#a16207" },
      { name: "Immobilien", description: "REITs und Immobilien-Aktien", color: "#84cc16" },
    ];
    await db.insert(categories).values(defaults);
    return { success: true, seeded: defaults.length };
  }),
});

