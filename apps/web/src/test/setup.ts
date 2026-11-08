import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetDb } from "../mocks/db.js";
import { handlers } from "../mocks/handlers.js";

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledFrame: "bypass" }));
afterEach(() => {
  server.resetHandlers();
  resetDb();
});
afterAll(() => server.close());
