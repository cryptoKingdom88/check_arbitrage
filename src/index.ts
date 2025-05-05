import { DatabaseManager } from './database/dbManager';
import { EventSubscriber } from './services/eventSubscriber';
import { ArbitrageCalculator } from './services/arbitrageCalculator';

async function main() {
	try {
		// Initialize database manager
		const dbManager = new DatabaseManager();
		await dbManager.initialize();

		// Initialize arbitrage calculator
		const arbitrageCalculator = new ArbitrageCalculator(dbManager);

		// Initialize event subscriber
		const eventSubscriber = new EventSubscriber(dbManager, arbitrageCalculator);

		// Fetch initial pool reserves
		await eventSubscriber.fetchInitialPoolReserves();

		// Start listening for events
		console.log('Listening for Swap events...');
		await eventSubscriber.subscribeToPoolsInBatches();
	} catch (error) {
		console.error('Error in main:', error);
	}
}

main().catch(console.error); 
