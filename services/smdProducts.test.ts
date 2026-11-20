import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMD_PRODUCT_CATALOG, smdBase, parseSmdAssemblies, matchSmdProducts, relatedSmdData } from './smdProducts';

test('loads all supplied SMD relationships, including the confirmed PR-1 correction', () => {
    assert.equal(SMD_PRODUCT_CATALOG.length, 207);
    assert.equal(SMD_PRODUCT_CATALOG.find(row => row.product === 'PR-1')?.smd, 'A2392-000');
});

test('groups only three-digit revision suffixes and preserves the original part values', () => {
    for (const part of ['A3602-005', 'A3602-006', 'a3602-007', ' A3602 ']) assert.equal(smdBase(part), 'A3602');
    assert.equal(smdBase('A3602-05'), 'A3602-05');
    assert.equal(smdBase('A3602-0005'), 'A3602-0005');
    const change = { assembly: 'A3602-005', old_component: 'ORIGINAL' };
    const before = { ...change };
    matchSmdProducts(change);
    assert.deepEqual(change, before);
});

test('all revisions of A3602 map to both CO1224 SKUs in SECURITY', () => {
    for (const assembly of ['A3602-005', 'A3602-006', 'A3602-007']) {
        const products = relatedSmdData({}, matchSmdProducts({ assembly }));
        assert.deepEqual(products.relatedSkus, ['CO1224T', 'CO1224TR']);
        assert.deepEqual(products.relatedFamilies, ['SECURITY']);
    }
});

test('finds affected SMD in each ECN part field and deduplicates repeated SKU associations', () => {
    for (const field of ['assembly', 'old_subassembly', 'new_subassembly', 'old_component', 'new_component']) {
        assert.equal(matchSmdProducts({ [field]: 'A3602-006' }).length, 2);
    }
    const change = { assembly: 'A3602-005', new_subassembly: 'A3602-007', sku: 'EXISTING', family: 'AMCO' };
    const related = relatedSmdData(change, matchSmdProducts(change));
    assert.equal(related.relatedProducts.length, 2);
    assert.ok(related.relatedSkus.includes('EXISTING'));
    assert.deepEqual(related.relatedFamilies, ['AMCO', 'SECURITY']);
});

test('different affected assemblies can produce multiple families without merging unrelated bases', () => {
    const data = relatedSmdData({}, matchSmdProducts({ assembly: 'A3602-005', new_component: 'A2511-999' }));
    assert.deepEqual(data.relatedFamilies, ['AMCO', 'SECURITY']);
    assert.ok(data.relatedSkus.includes('BEAMHK'));
    assert.equal(matchSmdProducts({ assembly: 'A36020-005' }).length, 0);
    assert.equal(matchSmdProducts({ assembly: 'UNKNOWN' }).length, 0);
});

test('accepts multiple SMD per product and removes repeated entries', () => {
    assert.deepEqual(parseSmdAssemblies('a3602-005; A2511-001, A3602-005\nA3602-007'), ['A3602-005', 'A2511-001', 'A3602-007']);
});
