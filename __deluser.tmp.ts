import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const EMAILS = [
  "test_mrndhttat38zanli_387awv68@example.test",
  "test_mrndhttat38zanli_5frwlpl0@example.test",
  "testms@gm.ccom",
  "testmcs@gm.ccom",
  "testmccs@gm.ccom",
];

(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const u = await c.query(
      `SELECT id, email FROM "User" WHERE email = ANY($1) FOR UPDATE`,
      [EMAILS],
    );
    const ids = u.rows.map((x: any) => x.id);
    console.log(
      `Locked ${ids.length} user(s): ${u.rows.map((x: any) => x.email).join(", ")}`,
    );
    if (ids.length !== EMAILS.length)
      throw new Error(
        `expected ${EMAILS.length} users, found ${ids.length} - aborting`,
      );

    const del = async (label: string, sql: string) => {
      const r = await c.query(sql, [ids]);
      console.log(`  deleted ${String(r.rowCount).padStart(3)}  ${label}`);
    };

    // Leaves -> root. Every FK -> User is RESTRICT, so nothing is implicitly cascaded.
    await del(
      "CreditTransaction",
      `DELETE FROM "CreditTransaction" WHERE "userId" = ANY($1)`,
    );
    await del(
      "CreditGrant",
      `DELETE FROM "CreditGrant"       WHERE "userId" = ANY($1)`,
    );
    await del(
      "Payment",
      `DELETE FROM "Payment"           WHERE "userId" = ANY($1)`,
    );
    await del(
      "PaymentMethod",
      `DELETE FROM "PaymentMethod"     WHERE "userId" = ANY($1)`,
    );
    await del(
      "CreditWallet",
      `DELETE FROM "CreditWallet"      WHERE "userId" = ANY($1)`,
    );
    // Invoice/SubscriptionEvent -> Subscription are RESTRICT: clear them before subs
    await del(
      "SubscriptionEvent",
      `
      DELETE FROM "SubscriptionEvent" e USING "Subscription" s
      WHERE s.id = e."subscriptionId" AND s."userId" = ANY($1)`,
    );
    await del(
      "Invoice",
      `
      DELETE FROM "Invoice" i USING "Subscription" s
      WHERE s.id = i."subscriptionId" AND s."userId" = ANY($1)`,
    );
    await del(
      "Subscription",
      `DELETE FROM "Subscription"      WHERE "userId" = ANY($1)`,
    );
    await del("User", `DELETE FROM "User"              WHERE id = ANY($1)`);

    await c.query("COMMIT");
    console.log("\nCOMMITTED");
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.log(
      `\nROLLED BACK - nothing deleted: ${e.code ?? ""} ${e.message}`,
    );
    if (e.constraint)
      console.log(`constraint: ${e.constraint}, table: ${e.table}`);
  } finally {
    c.release();
    await pool.end();
  }
})();
