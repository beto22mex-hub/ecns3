/**
 * Honeywell ECN Manager - SAP WebGUI Playwright Runner
 * 
 * Este script automatiza la extracción del reporte ZPP_CC07 desde SAP WebGUI
 * utilizando Microsoft Edge con Single Sign-On (SSO) corporativo de Honeywell.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Parámetros por línea de comandos o variables de entorno
const PLANT = process.env.SAP_PLANT || process.argv[2] || '5205';
const START_DATE = process.env.SAP_START_DATE || process.argv[3] || '';
const END_DATE = process.env.SAP_END_DATE || process.argv[4] || '';
const WEBGUI_URL = process.env.SAP_WEBGUI_URL || 'https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/';
const TRANSACTION = process.env.SAP_TRANSACTION || 'ZPP_CC07';

function formatToSapDate(isoOrAnyDate) {
    if (!isoOrAnyDate) {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 1);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}.${month}.${year}`;
    }
    const parts = isoOrAnyDate.split(/[-/.]/);
    if (parts.length === 3) {
        if (parts[0].length === 4) {
            // YYYY-MM-DD
            return `${parts[2].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[0]}`;
        }
        // DD-MM-YYYY
        return `${parts[0].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[2]}`;
    }
    return isoOrAnyDate;
}

function getTodaySapDate() {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
}

async function run() {
    console.log('================================================================');
    console.log('  HONEYWELL ECN MANAGER - AUTOMATIZADOR PLAYWRIGHT SAP WEBGUI');
    console.log('================================================================');
    console.log(`[Configuración] Transacción: ${TRANSACTION}`);
    console.log(`[Configuración] Planta SAP:  ${PLANT}`);
    
    const sapStartDate = formatToSapDate(START_DATE);
    const sapEndDate = END_DATE ? formatToSapDate(END_DATE) : getTodaySapDate();
    console.log(`[Configuración] Rango fechas: ${sapStartDate} hasta ${sapEndDate}`);
    console.log(`[Configuración] Servidor:    ${WEBGUI_URL}`);
    console.log('----------------------------------------------------------------');

    const downloadsDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    console.log('[1/5] Iniciando Microsoft Edge corporativo (con soporte SSO / Windows Auth)...');
    
    // Lanzar Edge con canal 'msedge' para aprovechar certificados y credenciales corporativas
    const browser = await chromium.launch({
        channel: 'msedge',
        headless: false, // Visible para que el usuario observe la ejecución o complete MFA si se solicita
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ]
    });

    const context = await browser.newContext({
        acceptDownloads: true,
        viewport: null
    });

    const page = await context.newPage();

    try {
        console.log(`[2/5] Navegando a SAP WebGUI (${WEBGUI_URL})...`);
        const targetUrl = `${WEBGUI_URL}?~transaction=${TRANSACTION}`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('[3/5] Esperando carga de pantalla y autenticación SSO...');
        // Espera a que cargue el formulario de SAP ITS WebGUI
        await page.waitForTimeout(5000);

        // Intento de llenar campos de ZPP_CC07
        console.log(`[4/5] Completando filtros de ZPP_CC07: Planta ${PLANT}, Fechas ${sapStartDate} a ${sapEndDate}...`);

        // Selector para Planta (WERKS)
        const plantInput = page.locator('input[title*="Plant" i], input[id*="WERKS" i], input[title*="Centro" i]').first();
        if (await plantInput.count() > 0) {
            await plantInput.fill(PLANT);
        }

        // Selector para Fecha Inicial (AEDAT-LOW)
        const dateLowInput = page.locator('input[id*="AEDAT-LOW" i], input[title*="Fecha" i], input[name*="AEDAT-LOW" i]').first();
        if (await dateLowInput.count() > 0) {
            await dateLowInput.fill(sapStartDate);
        }

        // Selector para Fecha Final (AEDAT-HIGH)
        const dateHighInput = page.locator('input[id*="AEDAT-HIGH" i], input[title*="Hasta" i], input[name*="AEDAT-HIGH" i]').first();
        if (await dateHighInput.count() > 0) {
            await dateHighInput.fill(sapEndDate);
        }

        console.log('[5/5] Ejecutando reporte en SAP (F8)...');
        await page.keyboard.press('F8');

        console.log('Esperando generación de resultados en SAP...');
        await page.waitForTimeout(7000);

        // Manejador de descarga de Excel
        console.log('Solicitando exportación a Hoja de Cálculo Excel...');
        const downloadPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null);

        // Buscar botón de exportación o combinación Ctrl+Shift+F7
        const exportBtn = page.locator('div[title*="Spreadsheet" i], div[title*="Hoja de cálculo" i], div[id*="btn[16]" i], [id*="M0:37::btn[16]" i]').first();
        if (await exportBtn.count() > 0) {
            await exportBtn.click();
        } else {
            await page.keyboard.press('Control+Shift+F7');
        }

        // Si aparece diálogo de confirmación de SAP WebGUI para exportar Excel
        await page.waitForTimeout(2000);
        const confirmBtn = page.locator('div[title*="Continue" i], div[title*="Continuar" i], div[id*="btn[0]" i]').first();
        if (await confirmBtn.count() > 0) {
            await confirmBtn.click();
        }

        const download = await downloadPromise;
        if (download) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `SAP_WebGUI_${PLANT}_${timestamp}.xlsx`;
            const filePath = path.join(downloadsDir, fileName);
            await download.saveAs(filePath);
            console.log('================================================================');
            console.log(' ¡DESCARGA EXITOSA!');
            console.log(` Archivo guardado en: ${filePath}`);
            console.log(' Puede arrastrar este archivo directamente a la pestaña de Cambios en ECN Manager.');
            console.log('================================================================');
        } else {
            console.log('[AVISO] La descarga no se inició automáticamente en el tiempo esperado.');
            console.log('Por favor revise la ventana de Edge abierta y presione Guardar si apareció el diálogo.');
        }

    } catch (error) {
        console.error('[ERROR]', error.message);
    } finally {
        console.log('\nProceso terminado. Cerrando navegador en 5 segundos...');
        await page.waitForTimeout(5000);
        await browser.close();
    }
}

run();
