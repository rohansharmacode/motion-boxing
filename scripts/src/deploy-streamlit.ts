// Deploys streamlit/ to Streamlit in Snowflake (stage + PUT + CREATE STREAMLIT), as in
// streamlit/README.md option B. Usage: npx tsx src/deploy-streamlit.ts [--role ACCOUNTADMIN]
// Also uploads the Snowflake Lab page (streamlit/pages/*.py -> <stage>/pages/) and, best effort,
// the Cortex Analyst semantic model to @MOTION_DB.PUBLIC.SEMANTIC_MODELS.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, connect, loadServerEnv } from './sf';

const roleIdx = process.argv.indexOf('--role');
const role = roleIdx >= 0 ? process.argv[roleIdx + 1]! : 'ACCOUNTADMIN';
const APP = 'MOTION_DB.PUBLIC.MOTION_DASHBOARD';
const STAGE = '@MOTION_DB.PUBLIC.STREAMLIT_SRC/motion';
const SEMANTIC_STAGE = '@MOTION_DB.PUBLIC.SEMANTIC_MODELS';

const fileUrl = (p: string) => `'file://${p.replace(/\\/g, '/')}'`;

const conn = await connect({ role, database: 'MOTION_DB' });
try {
  await conn.exec('CREATE STAGE IF NOT EXISTS MOTION_DB.PUBLIC.STREAMLIT_SRC DIRECTORY = (ENABLE = TRUE)');
  for (const f of ['app.py', 'logic.py', 'plus_logic.py', 'environment.yml']) {
    const local = path.join(ROOT, 'streamlit', f);
    await conn.exec(`PUT ${fileUrl(local)} ${STAGE} AUTO_COMPRESS = FALSE OVERWRITE = TRUE`);
    console.log(`uploaded ${f}`);
  }
  // Multipage: SiS treats every .py file in pages/ next to the main file as an extra page.
  const pagesDir = path.join(ROOT, 'streamlit', 'pages');
  const pages = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith('.py')).sort() : [];
  for (const f of pages) {
    await conn.exec(`PUT ${fileUrl(path.join(pagesDir, f))} ${STAGE}/pages AUTO_COMPRESS = FALSE OVERWRITE = TRUE`);
    console.log(`uploaded pages/${f}`);
  }
  try {
    const yaml = path.join(ROOT, 'sql', 'semantic_model', 'motion_boxing.yaml');
    if (!existsSync(yaml)) throw new Error('sql/semantic_model/motion_boxing.yaml not found');
    await conn.exec(`PUT ${fileUrl(yaml)} ${SEMANTIC_STAGE} AUTO_COMPRESS = FALSE OVERWRITE = TRUE`);
    console.log(`uploaded motion_boxing.yaml to ${SEMANTIC_STAGE}`);
  } catch (err) {
    console.log(`(semantic model not uploaded: ${(err as Error).message.split('\n')[0]}; run sql/semantic.sql first)`);
  }
  await conn.exec(`CREATE OR REPLACE STREAMLIT ${APP} FROM ${STAGE} MAIN_FILE = 'app.py' QUERY_WAREHOUSE = MOTION_WH TITLE = 'Motion Boxing Coach'`);
  try {
    await conn.exec(`ALTER STREAMLIT ${APP} ADD LIVE VERSION FROM LAST`);
  } catch (err) {
    console.log(`(live version: ${(err as Error).message.split('\n')[0]}; opening it once in Snowsight also works)`);
  }
  await conn.exec(`GRANT USAGE ON STREAMLIT ${APP} TO ROLE MOTION_APP_ROLE`).catch(() => undefined);
  const acct = loadServerEnv().SNOWFLAKE_ACCOUNT ?? '<org-account>';
  const [org, name] = acct.toLowerCase().split('-');
  console.log(`deployed ${APP}`);
  console.log(`open: https://app.snowflake.com/${org}/${name ?? ''}/#/streamlit-apps/${APP}`);
} finally {
  await conn.close();
}
