import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { getApplicationStatus } from "../../src/lib/uspto";

const USAGE = `Usage:
  npm run uspto:status -- --application <application-number>

Options:
  --application, -a  USPTO application number, e.g. 18/045,436 or 18045436.
  --help, -h         Show this help.

Notes:
  Requires USPTO_ODP_KEY in .env.local. The key is never printed.
`;

function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      application: { type: "string", short: "a" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (!values.application) {
    fail("--application is required.");
  }

  loadEnvConfig(process.cwd());

  if (!process.env.USPTO_ODP_KEY) {
    fail("USPTO_ODP_KEY is not set in the current environment.");
  }

  const status = await getApplicationStatus(values.application);
  console.log(JSON.stringify(status, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
