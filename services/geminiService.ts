import { GoogleGenAI } from "@google/genai";
import { ECN, ComponentChange } from "../types";

// --- Configuración ---
// Vertex AI (usa ADC / gcloud auth): no pasa por el bloqueo de Zscaler a generativelanguage.googleapis.com
const GCP_PROJECT = process.env.GCP_PROJECT || "creditwise-backend";
const GCP_LOCATION = process.env.GCP_LOCATION || "global";

// Fallback: OpenAI (requiere créditos en la cuenta)
const backupApiKey = process.env.OPENAI_API_KEY || process.env.COPILOT_API_KEY;

/**
 * Genera un resumen de ECN usando Gemini (Vertex AI o API directa), con respaldo a OpenAI si falla.
 */
export const generateEcnSummary = async (ecn: ECN): Promise<any> => {
  const prompt = buildSummaryPrompt(ecn);

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const clientOptions: any = {};
    if (apiKey) {
      console.log("[AI] Inicializando Gemini con GEMINI_API_KEY directa...");
      clientOptions.apiKey = apiKey;
    } else {
      console.log(`[AI] Intentando con Vertex AI (proyecto: ${GCP_PROJECT}, región: ${GCP_LOCATION})...`);
      clientOptions.vertexai = true;
      clientOptions.project = GCP_PROJECT;
      clientOptions.location = GCP_LOCATION;
    }

    const ai = new GoogleGenAI(clientOptions);

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "Eres un ingeniero experto en gestión y control de cambios de ingeniería (ECN) para Honeywell. Tu misión es redactar resúmenes ejecutivos concisos y profesionales. REGLA ESTRICTA DE IDIOMA: Todo el texto generado, especialmente el campo 'summary', 'documentsAffected', 'manufacturingActions' y 'firmwareChange', DEBE ESTAR OBLIGATORIAMENTE REDACTADO 100% EN ESPAÑOL, traduciendo y explicando cualquier término o descripción técnica que venga en inglés.",
        temperature: 0.3,
        responseMimeType: "application/json"
      }
    });

    const content = result.text;

    if (!content) {
      throw new Error("El servicio de IA no devolvió contenido.");
    }

    console.log("[AI] Respuesta recibida exitosamente.");

    // Extraer JSON si viene envuelto en markdown (```json ... ```)
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

    try {
      return JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("[AI] Error al parsear JSON:", parseError, "Contenido:", content);
      throw new Error("El servicio de IA devolvió un formato no válido.");
    }

  } catch (vertexError: any) {
    console.warn("[AI] Gemini/Vertex AI falló:", vertexError?.message || vertexError);

    // 2. Fallback a OpenAI
    if (backupApiKey) {
      try {
        console.log("[AI] Intentando fallback con OpenAI...");
        return await generateEcnSummaryWithOpenAI(prompt);
      } catch (openaiError: any) {
        console.error("[AI] OpenAI también falló:", openaiError?.message || openaiError);
      }
    } else {
      console.warn("[AI] OPENAI_API_KEY no configurada, saltando fallback OpenAI.");
    }

    // 3. Último recurso: resumen generado localmente sin IA
    console.warn("[AI] Ambos servicios fallaron. Generando resumen local de respaldo en español.");
    return generateLocalFallbackSummary(ecn);
  }
};

/**
 * Construye el prompt para la generación del resumen obligatoriamente en español.
 */
const buildSummaryPrompt = (ecn: ECN): string => {
  const componentsInfo = (ecn.changes || []).map((c: ComponentChange) =>
    `- Ensamble: ${c.assembly || 'N/A'} (Sitio: ${c.site || 'N/A'})
     Componente Viejo: ${c.oldComponent || 'N/A'}
     Componente Nuevo: ${c.newComponent || 'N/A'} (Descripción: ${c.newComponentDescription || 'N/A'})
     Familia: ${c.family || 'N/A'}
     Fecha Inicio: ${c.startDate || 'N/A'}`
  ).join('\n');

  return `Analiza el siguiente Cambio de Ingeniería (ECN) de Honeywell y genera un resumen ejecutivo conciso.
  Extrae la información relevante y devuélvela en formato JSON válido.

  Datos del ECN:
  ID ECN: ${ecn.id}
  Descripción original: ${ecn.description || 'Sin descripción'}
  Iniciador: ${ecn.initiator || 'N/A'}
  Estatus actual: ${ecn.status || 'N/A'}
  
  Detalle de componentes involucrados:
  ${componentsInfo || 'Sin detalles de componentes'}

  ==============================================================
  REGLA FUNDAMENTAL DE IDIOMA (OBLIGATORIO EN ESPAÑOL):
  - TODO el texto de los campos generados DEBE ESTAR 100% EN ESPAÑOL.
  - Aunque la descripción original o los nombres de las piezas en SAP estén en inglés, tradúcelos y explícalos claramente en español.
  ==============================================================

  Instrucciones para los campos del JSON:
  - 'ecn': El ID del ECN (${ecn.id}).
  - 'firmwareChange': Determina si el ECN implica un cambio de firmware basándote en la descripción o componentes. Si aplica, explícalo en español; si no aplica, deja un string vacío.
  - 'summary': Resumen ejecutivo conciso del ECN en ESPAÑOL, de máximo 3 a 5 líneas. Debe ser claro y profesional, explicando qué cambia, qué componentes o ensambles se modifican y cuál es el impacto de producción para los ingenieros de planta.
  - 'newMaterials': Array de strings con los 'newComponent' que no tienen un 'oldComponent' asociado (piezas nuevas agregadas).
  - 'revisedMaterials': Array de strings con los 'newComponent' que tienen un 'oldComponent' asociado (piezas modificadas o sustituidas).
  - 'documentsAffected': Array de strings en ESPAÑOL con nombres de documentos que podrían verse afectados (ej. "Lista de Materiales (BOM)", "Instrucciones de Trabajo", "Hojas de Ensamble", "Dibujos de Ingeniería"). Si no se deduce claramente, deja un array vacío.
  - 'plantsAffected': Array de strings con los identificadores de planta o sitio afectados.
  - 'manufacturingActions': Array de strings en ESPAÑOL con las acciones de manufactura requeridas (ej. "Actualización de herramental", "Consumo de inventario obsoleto", "Ajuste de parámetros en línea de producción", "Capacitación a operadores"). Si no se deduce información clara, deja un array vacío.

  Devuelve SOLAMENTE JSON válido con la siguiente estructura:
  {
    "ecn": "${ecn.id}",
    "firmwareChange": "",
    "summary": "",
    "newMaterials": [],
    "revisedMaterials": [],
    "documentsAffected": [],
    "plantsAffected": [],
    "manufacturingActions": []
  }
  `;
};

/**
 * Fallback usando OpenAI.
 */
const generateEcnSummaryWithOpenAI3 = async (prompt: string): Promise<any> => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${backupApiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Eres un asistente experto en ingeniería y control de cambios (ECN) de Honeywell. Genera resúmenes ejecutivos claros y concisos en formato JSON válido. REGLA ESTRICTA DE IDIOMA: Todo el resumen ('summary') y textos explicativos deben estar obligatoriamente en español profesional, traduciendo cualquier dato técnico en inglés al español." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => response.statusText);
    throw new Error(`OpenAI respondió ${response.status}: ${errBody}`);
  }

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI no devolvió contenido.");
  }

  return JSON.parse(content);
};


const generateEcnSummaryWithOpenAI = async (prompt: string): Promise<any> => {
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${backupApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions:
          "Eres un asistente experto en ingeniería y control de cambios (ECN) de Honeywell. Genera resúmenes ejecutivos claros y concisos en formato JSON válido. REGLA ESTRICTA DE IDIOMA: Todo el resumen ('summary') y textos explicativos deben estar obligatoriamente en español profesional, traduciendo cualquier dato técnico en inglés al español.",
        input: prompt
      })
    }
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => response.statusText);
    throw new Error(
      `OpenAI respondió ${response.status}: ${errBody}`
    );
  }

  const data = await response.json();

  if (!data.output_text) {
    console.error("Respuesta completa:", data);
    throw new Error("OpenAI no devolvió contenido.");
  }
  console.log(data.output_text);
  return JSON.parse(data.output_text);
};

/**
 * Último recurso: genera un resumen estructurado sin IA,
 * basado directamente en los datos del ECN.
 */
const generateLocalFallbackSummary = (ecn: ECN): any => {
  const changes = ecn.changes || [];
  const sites = Array.from(new Set(changes.map(c => c.site).filter(Boolean)));
  const newMaterials = changes.filter(c => !c.oldComponent && c.newComponent).map(c => c.newComponent!);
  const revisedMaterials = changes.filter(c => c.oldComponent && c.newComponent).map(c => c.newComponent!);

  const changeCount = changes.length;
  const summary = `ECN ${ecn.id}: ${ecn.description || 'Sin descripción'}. ` +
    `Iniciado por ${ecn.initiator || 'N/A'}, estatus: ${ecn.status}. ` +
    `Involucra ${changeCount} cambio(s) de componente en ${sites.length} sitio(s). ` +
    `(Resumen generado localmente — servicio de IA no disponible.)`;

  return {
    ecn: ecn.id,
    firmwareChange: "",
    summary,
    newMaterials,
    revisedMaterials,
    documentsAffected: changeCount > 0 ? ["BOM"] : [],
    plantsAffected: sites,
    manufacturingActions: [],
    _generatedLocally: true
  };
};
