import https from "https";
import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { RagfairServer } from "@spt-aki/servers/RagfairServer";
import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { LogTextColor } from "@spt-aki/models/spt/logging/LogTextColor";
import { LogBackgroundColor } from "@spt-aki/models/spt/logging/LogBackgroundColor";
import { RagfairPriceService } from "@spt-aki/services/RagfairPriceService";
import { RagfairOfferService } from "@spt-aki/services/RagfairOfferService";

import pkg from "../package.json";
import modConfig from "../config/config.json";

const query = "{\"query\":\"{\\n\\t\\titems(type: any){\\n\\t\\t\\tid\\n\\t\\t\\tavg24hPrice\\n\\t\\t\\tsellFor {\\n\\t\\t\\t\\tprice\\n\\t\\t\\t}\\n\\t\\t\\t\\thistoricalPrices{\\n\\t\\t\\t\\tprice\\n\\t\\t\\t\\ttimestamp\\n\\t\\t\\t}\\n\\t\\t}\\n\\t}\\n\"}"
const headers = {
    hostname: "api.tarkov.dev",
    path: "/graphql",
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
};

class Mod implements IPostDBLoadMod
{
    private static modName: string = `${pkg.author}-${pkg.name}`;
    private static updateInterval: number = (!modConfig?.UpdateIntervalSecond || typeof(modConfig.UpdateIntervalSecond) !== "number" || modConfig.UpdateIntervalSecond < 600 ? 600 : modConfig.UpdateIntervalSecond)*1000;
    private static container: DependencyContainer;
    protected static updateTimer: number; 

    public postDBLoad(container: DependencyContainer): void 
    {
		// S P T 3 . 0 . 0
		Mod.container = container;

        const logger = container.resolve<ILogger>("WinstonLogger");

        logger.info(`Loading: ${Mod.modName} ${pkg.version}${modConfig.Enabled ? ` - Update Interval: ${(Mod.updateInterval/60000).toFixed(0)} mins` : " [Disabled]"}`);
		if (!modConfig.Enabled)
		{
			return;
		}
        
        Mod.updatePrices(true);
        Mod.updateTimer = setInterval(Mod.updatePrices, Mod.updateInterval, false);
    }

    static updatePrices(init: Boolean = false): void
    {
        const logger = Mod.container.resolve<ILogger>("WinstonLogger");
        const databaseServer = Mod.container.resolve<DatabaseServer>("DatabaseServer");
        const pricesTable = databaseServer.getTables().templates.prices;

        logger.log(`${Mod.modName} - Requesting price data from the api server...`, LogTextColor.BLACK, LogBackgroundColor.YELLOW);
        const req = https.request(headers, res => 
        {
            // Hooray, we have the data and alive api server
            if (res.statusCode == 200)
            {
                // Thinking
                let response = "";
                res.on("data", function(d) 
                {
                    response += d;
                });

                // And more thinking
                res.on("end", function(d) 
                {
                    // Harder
                    try
                    {
                        // Parse the data from the api server
                        const respond = JSON.parse(response);

                        // Configs
                        const updateFilters = modConfig?.UpdateFilters;
                        const updateBannedItems = modConfig?.UpdatePricesFromTradersForBannedItems;

                        let priceFilter = updateFilters.Prices.toString() || "avg";
                        if (priceFilter != "avg" && priceFilter != "lowest" && priceFilter != "highest")
                        {
                            priceFilter = "avg";
                            logger.error(`${Mod.modName}: Config "UpdateFilters" - "Prices" has bad value "${updateFilters?.Prices}", using default value: avg`);
                        }

                        let priceTimeLimit = Number(updateFilters.LimitPriceDataWithinTime_Hour) || 24;

                        // UwU
                        let updateCount = 0;

                        // What's dis?
                        for (const i in respond.data.items)
                        {
                            const apiData = respond.data.items[i];
                            const itemId = apiData.id;
                            const avg24hPrice = apiData.avg24hPrice;
                            let price = 0;

                            // Blacklist check
                            let skip = false;
                            for (const j in modConfig.Blacklist)
                            {
                                if (modConfig.Blacklist[j] === itemId)
                                {
                                    skip = true;
                                    break;
                                }
                            }
                            if (skip === true) continue;

	
                            // Bitcoin price from Therapist
                            /* No longer used since item has banned from live flea market and no data to use
                            if (id === "59faff1d86f7746c51718c9c")
                            {
                                for (const trader in datas.data.items[i].traderPrices)
                                {
                                    if (datas.data.items[i].traderPrices[trader].trader.name.toLowerCase() === "therapist")
                                    {
                                        price = datas.data.items[i].traderPrices[trader].price;
                                        break;
                                    }
                                }
                            } */

                            // Skip undefiend items
                            /* but we don't need to skip it, we might needs when we playing BE or Up-Versions
                            if (!pricesTable[id])
                            {
                                continue;
                            } */

                            // Skip or update prices from traders for banned items
                            if (avg24hPrice < 1 && !apiData.historicalPrices?.length)
                            {
                                // No thx by user's choice or no data to use at all
                                if (!updateBannedItems?.Enabled || !apiData.sellFor?.length)
                                {
                                    continue;
                                }

                                let pickedPrice = 0;
                                for (const p in apiData.sellFor)
                                {
                                    pickedPrice = Math.max(apiData.sellFor[p].price, pickedPrice);
                                }

                                if (updateBannedItems?.LowPricedItemsOnly)
                                {
                                    if (pricesTable[itemId] < pickedPrice)
                                    {
                                        price = pickedPrice;
                                    }
                                }
                                else if (pickedPrice > 0)
                                {
                                    // Update the item price anyway, by user's choice
                                    price = pickedPrice;
                                }
                                else
                                {
                                    // Nothing to update
                                    continue;
                                }
                            }
                            else // We have actual price data from the api server
                            {
                                // Ez price
                                if (priceFilter == "avg" && priceTimeLimit === 24 && avg24hPrice > 0)
                                {
                                    price = avg24hPrice;
                                }
                                // Time to do some math
                                else if (apiData.historicalPrices?.length)
                                {
                                    const timestamp = priceTimeLimit > 0 ? Date.now() - priceTimeLimit * 3600000 : 0;

                                    let pickedPrice = [];
                                    for (const p in apiData.historicalPrices)
                                    {
                                        const data = apiData.historicalPrices[p];
                                        if (timestamp <= data.timestamp)
                                        {
                                            switch(priceFilter)
                                            {
                                                case "lowest":
                                                {
                                                    pickedPrice[0] = Math.min(data.price, pickedPrice[0]);
                                                    break;
                                                }

                                                case "avg":
                                                {
                                                    pickedPrice.push(data.price);
                                                    break;
                                                }

                                                case "highest":
                                                {
                                                    pickedPrice[0] = Math.max(data.price, pickedPrice[0]);
                                                    break;
                                                }
                                            }
                                        }
                                    }

                                    if (pickedPrice.length)
                                    {
                                        if (priceFilter != "avg")
                                        {
                                            price = pickedPrice[0];
                                        }
                                        else // avg
                                        {
                                            price = pickedPrice.reduce((a, b) => a + b, 0) / pickedPrice.length;
                                        }
                                    }
                                    else // No data at all, wtf.
                                    {
                                        continue;
                                    }
                                }
                                else
                                {
                                    // No data at all, wtf.
                                    if (avg24hPrice < 1)
                                    {
                                        continue;
                                    }
                                    else // I guess this is what we've got now
                                    {
                                        price = avg24hPrice;
                                    }
                                }
                            }

                            // Finall we got a new price?
                            if (pricesTable[itemId] !== price && price > 0)
                            {
                                updateCount++;
                                pricesTable[itemId] = price;
                            }
                        }

                        // Did we do it?
                        if (updateCount)
                        {
                            logger.log(`${Mod.modName}: Updated market data, Total ${updateCount} items`, LogTextColor.BLACK, LogBackgroundColor.CYAN);
                        }
                        else
                        {
                            logger.log(`${Mod.modName}: Already up to date!`, LogTextColor.WHITE, LogBackgroundColor.MAGENTA);
                        }

                        // Generate flea market offers with new prices, Only once upon load
                        if (init)
                        {
                            const traders = databaseServer.getTables().traders;
                            for (const traderId in traders)
                            {
                                traders[traderId].base.refreshTraderRagfairOffers = true;
                            }
                            Mod.container.resolve<RagfairOfferService>("RagfairOfferService").offers = [];
                            Mod.container.resolve<RagfairPriceService>("RagfairPriceService").generateDynamicPrices();
                            Mod.container.resolve<RagfairServer>("RagfairServer").load();
                            logger.log(`${Mod.modName}: Generated initial flea market offers`, LogTextColor.WHITE, LogBackgroundColor.MAGENTA);
                        }
                    }
                    catch (error) 
                    {
                        logger.error(`${Mod.modName}: ${error}`);
                    }
                });
            }
            else
            {
                let reason = "Failed to update market data";

                if (res.statusCode >= 400 && res.statusCode <= 403)
                {
                    reason = "Tarkov.dev might banned your IP for an hour or having trouble on the server";
                }
                else if (res.statusCode == 503)
                {
                    reason = "Tarkov.dev is offline";
                }

                logger.error(`${Mod.modName}: (${res.statusCode}) ${reason}. Retry in ${(Mod.updateInterval/60000).toFixed(0)} mins`);
            }
        }).on("error", error =>
        {
            logger.error(`${Mod.modName}: ${error} - Mod disabled`);
            clearInterval(Mod.updateTimer);
        });

        req.write(query);
        req.end();
    }
}

module.exports = { mod: new Mod() }