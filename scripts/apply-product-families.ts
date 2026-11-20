import 'dotenv/config';
import * as db from '../db.ts';

async function main() {
    await db.init();
    if (!db.isLiveMssqlConnected()) throw new Error('No hay conexión SQL real; no se ha actualizado la base de datos.');
    const result = await db.pool.request().query(`
        SELECT COUNT(*) AS catalogProducts FROM dbo.product_family_catalog;
        SELECT COUNT(*) AS matchedRecords,
            SUM(CASE WHEN ISNULL(c.family,'') COLLATE Latin1_General_100_BIN2 <> COALESCE(s.family,a.family) COLLATE Latin1_General_100_BIN2 THEN 1 ELSE 0 END) AS mismatches
        FROM dbo.component_changes c
        LEFT JOIN dbo.product_family_catalog s ON UPPER(LTRIM(RTRIM(c.sku)))=s.product
        LEFT JOIN dbo.product_family_catalog a ON UPPER(LTRIM(RTRIM(c.assembly)))=a.product
        WHERE COALESCE(s.family,a.family) IS NOT NULL;
        SELECT CASE WHEN OBJECT_ID('dbo.tr_component_changes_product_family', 'TR') IS NOT NULL THEN 1 ELSE 0 END AS automaticUpdateEnabled;
        SELECT SUM(total) AS legacyFamilyRows FROM (
            SELECT COUNT(*) AS total FROM dbo.component_changes WHERE family IN ('SOUNDER BA','SOUNDER BASE','LI-ON')
            UNION ALL SELECT COUNT(*) FROM dbo.implementation_tasks WHERE family IN ('SOUNDER BA','SOUNDER BASE','LI-ON')
            UNION ALL SELECT COUNT(*) FROM dbo.product_family_catalog WHERE family IN ('SOUNDER BA','SOUNDER BASE','LI-ON')
            UNION ALL SELECT COUNT(*) FROM dbo.users WHERE families LIKE '%"SOUNDER BASE"%' OR families LIKE '%"SOUNDER BA"%' OR families LIKE '%"LI-ON"%'
        ) counts;
    `);
    console.log(JSON.stringify(result.recordsets));
    const sets = result.recordsets as any[];
    if (sets[0][0].catalogProducts < 460 || sets[1][0].mismatches > 0 || !sets[2][0].automaticUpdateEnabled || sets[3][0].legacyFamilyRows > 0) throw new Error('La validación del catálogo Product/SBU no pasó.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await db.pool.close(); });
