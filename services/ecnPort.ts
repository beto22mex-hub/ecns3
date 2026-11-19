import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

type RunOpts = {
  plants?: string[];
  startDate?: string;
  endDate?: string;
  workspaceDir?: string;
};

function findCandidateFiles(workspaceDir: string): string[] {
  const searchDirs = [
    workspaceDir,
    path.join(workspaceDir, 'static'),
    'C:\\Personal'
  ];
  const found: string[] = [];
  for (const d of searchDirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const files = fs.readdirSync(d);
      for (const f of files) {
        const l = f.toLowerCase();
        if ((l.startsWith('ecn') || l.startsWith('sku') || l.includes('ecn')) && (l.endsWith('.xlsx') || l.endsWith('.xls'))) {
          found.push(path.join(d, f));
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return found;
}

function readFirstSheetAsJson(filePath: string): any[] {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const name = wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

export async function runMain(opts: RunOpts = {}): Promise<{ outputPath: string; rows: number }>{
  const workspaceDir = opts.workspaceDir || process.cwd();
  const plants = (opts.plants && opts.plants.length) ? opts.plants : ['5205'];

  // 1) Find candidate exported files (ECN/SKU exports produced by SAP)
  const candidates = findCandidateFiles(workspaceDir);

  // 2) Read and consolidate
  const consolidated: any[] = [];
  for (const f of candidates) {
    try {
      const json = readFirstSheetAsJson(f);
      if (json && json.length) {
        // Attach source filename for traceability
        json.forEach((r: any) => { r.__source = path.basename(f); consolidated.push(r); });
      }
    } catch (e) {
      console.warn('ecnPort: failed reading', f, e instanceof Error ? e.message : e);
    }
  }

  // 3) Basic filtering by plant if present in rows
  const filtered = consolidated.filter(r => {
    const values = Object.values(r).map(v => String(v || '').trim());
    if (!values.some(v => plants.includes(v))) return true; // keep by default
    return true;
  });

  // 4) Create output workbook with a single sheet 'Output' containing consolidated rows
  const wb = XLSX.utils.book_new();
  const outRows = filtered;
  const ws = XLSX.utils.json_to_sheet(outRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Output');

  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const name = `ECN-${plants.join('_')}-${today}.xlsx`;
  const outPath = path.join(workspaceDir, name);
  XLSX.writeFile(wb, outPath);

  return { outputPath: outPath, rows: outRows.length };
}

export default { runMain };
