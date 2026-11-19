/*
  Prototipo de automatización SAP GUI desde Node.js usando winax (ActiveX/COM).
  Requisitos:
  - Ejecutar en Windows con SAP GUI instalado y SAP GUI Scripting habilitado.
  - Instalar la dependencia: `npm install winax` (requiere build tools).
  - Ejecutar el proceso en una sesión de usuario interactiva (no como servicio sin GUI).

  Nota: Este archivo es un punto de partida. Ajusta los IDs y flujos según tu entorno SAP.
*/

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let ActiveXObject: any;
try {
  ({ ActiveXObject } = require('winax'));
} catch (e) {
  // winax no está instalado; las llamadas lanzarán errores al usar este módulo
  ActiveXObject = null;
}

function getSession(): any {
  if (!ActiveXObject) throw new Error('winax no disponible. Ejecuta `npm install winax` en Windows.');
  const SapGuiAuto = new ActiveXObject('Sapgui.ScriptingCtrl.1');
  const application = SapGuiAuto.GetScriptingEngine();
  const connection = application.Children(0);
  const session = connection.Children(0);
  return session;
}

function waitForFile(filePath: string, timeoutSec = 60): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(iv);
        resolve(true);
      }
      if ((Date.now() - start) / 1000 > timeoutSec) {
        clearInterval(iv);
        resolve(false);
      }
    }, 1000);
  });
}

export async function exportEcnForPlants(plants: string[], initialDate: string, finalDate: string, exportFolder: string): Promise<string[]> {
  const session = getSession();
  const exported: string[] = [];

  for (const plant of plants) {
    const today = new Date();
    const name = `ECN${plant}-${today.getFullYear().toString().slice(-2)}${(today.getMonth()+1).toString().padStart(2,'0')}${today.getDate().toString().padStart(2,'0')}.xlsx`;
    const outPath = path.join(exportFolder, name);

    // Example flow similar to VBA: navigate, set filters, export
    try {
      // go home (press back/up) - the ids mirror the VBA script
      session.findById('wnd[0]/tbar[0]/btn[3]').press();
      session.findById('wnd[0]/tbar[0]/btn[3]').press();
      session.findById('wnd[0]/tbar[0]/btn[3]').press();

      session.findById('wnd[0]').maximize();

      session.findById('wnd[0]/tbar[0]/okcd').Text = 'ZPP_CC07';
      session.findById('wnd[0]').SendVKey(0);

      // set plant
      session.findById('wnd[0]/usr/chkP002').Selected = false;
      session.findById('wnd[0]/usr/ctxtP001').Text = plant;

      // set dates (format expected like dd.mm.yyyy)
      session.findById('wnd[0]/usr/ctxtS001-LOW').Text = initialDate;
      session.findById('wnd[0]/usr/ctxtS001-HIGH').Text = finalDate;
      session.findById('wnd[0]').SendVKey(8);

      // open export menu (may vary by system)
      session.findById('wnd[0]/mbar/menu[0]/menu[3]/menu[1]').Select();

      // fill path and filename in the file dialog
      // Note: window indices (wnd[1]) might change depending on UI; adjust if necessary
      session.findById('wnd[1]/usr/ctxtDY_PATH').Text = exportFolder;
      session.findById('wnd[1]/usr/ctxtDY_FILENAME').Text = name;
      session.findById('wnd[1]/tbar[0]/btn[11]').press();

      const ok = await waitForFile(outPath, 90);
      if (!ok) throw new Error(`Export timeout: ${outPath}`);
      exported.push(outPath);
    } catch (err) {
      throw new Error('SAP GUI automation failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  return exported;
}

export default { exportEcnForPlants };
