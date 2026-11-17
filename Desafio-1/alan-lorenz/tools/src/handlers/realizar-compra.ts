import { createDynamoPaymentStore } from '../dynamodb-store.ts';
import { createToolHandlers } from './inputs.ts';

const handlers = createToolHandlers(createDynamoPaymentStore());

export const handler = handlers.realizar_compra;
