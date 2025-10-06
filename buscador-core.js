const fs = require('fs').promises;
const path = require('path');

// Importaciones CommonJS
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const mammoth = require('mammoth');
const xlsx = require('xlsx');

// Configurar pdfjs-dist
pdfjsLib.GlobalWorkerOptions.workerSrc = require('pdfjs-dist/legacy/build/pdf.worker.js');

// --- Función para extraer texto de PDF con información de páginas ---
const getPdfTextByPage = async (filePath) => {
    try {
        const data = new Uint8Array(await fs.readFile(filePath));
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const numPages = pdf.numPages;
        const pages = [];

        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            
            let pageText = "";
            for (const item of textContent.items) {
                pageText += item.str + " ";
            }
            
            pages.push({
                pageNumber: i,
                text: pageText.trim()
            });
        }

        await pdf.destroy();
        return pages;
    } catch (error) {
        throw new Error(`Error al extraer texto del PDF: ${error.message}`);
    }
};

// --- Función auxiliar para obtener fragmentos de contexto alrededor de la cadena buscada ---
const _getContextSnippets = (fullText, searchString, contextChars, pageNumber = null) => {
    const snippets = [];
    const textLower = fullText.toLowerCase();
    const searchStringLower = searchString.toLowerCase();

    const searchRegex = new RegExp(searchStringLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

    let match;
    while ((match = searchRegex.exec(textLower)) !== null) {
        const pos = match.index;
        const foundText = fullText.substring(pos, pos + searchString.length);

        let snippet;
        if (contextChars > 0) {
            const startContext = Math.max(0, pos - contextChars);
            const endContext = Math.min(fullText.length, pos + searchString.length + contextChars);

            const rawSnippet = fullText.substring(startContext, endContext);
            snippet = rawSnippet.replace(/[\r\n]+/g, ' ').trim();

            if (startContext > 0) snippet = `...${snippet}`;
            if (endContext < fullText.length) snippet = `${snippet}...`;

            snippet = snippet.replace(new RegExp(searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), `>>>$&<<<`);

        } else {
            snippet = `>>>${foundText}<<<`;
        }

        // Agregar información de página si está disponible
        if (pageNumber !== null) {
            snippet = `[Página ${pageNumber}] ${snippet}`;
        }

        snippets.push(snippet);
    }
    return snippets;
};

// --- Funciones de procesamiento por tipo de archivo ---

const procesarPdf = async (rutaArchivo, listaStrings, contextChars, hallazgosPorString) => {
    const hallazgos = [];
    const problemas = [];
    const nombreBase = path.basename(rutaArchivo);
    const archivoResult = { archivo: nombreBase, tipo: 'PDF', totalCoincidencias: 0, coincidencias: [] };

    try {
        const paginas = await getPdfTextByPage(rutaArchivo);
        
        // Verificar si hay texto en alguna página
        const tieneTexto = paginas.some(pagina => pagina.text && pagina.text.trim());
        if (!tieneTexto) {
            problemas.push(`Archivo: '${nombreBase}' (PDF) -> Advertencia: Archivo PDF vacío o sin texto extraíble.`);
            return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'advertencia', errorDetalle: 'Archivo vacío o sin texto extraíble.' } };
        }

        for (const stringBuscado of listaStrings) {
            let coincidenciasPorTermino = 0;
            const fragmentosConPagina = [];

            // Buscar en cada página individualmente
            for (const pagina of paginas) {
                if (!pagina.text || !pagina.text.trim()) continue;
                
                const snippets = _getContextSnippets(pagina.text, stringBuscado, contextChars, pagina.pageNumber);
                
                if (snippets.length > 0) {
                    coincidenciasPorTermino += snippets.length;
                    fragmentosConPagina.push(...snippets);

                    // Registrar hallazgos para el reporte TXT
                    hallazgos.push(`\nArchivo: '${nombreBase}' (PDF) - Página ${pagina.pageNumber} -> Encontrado: '${stringBuscado}'`);
                    hallazgos.push(...snippets.map(s => `  └─ ${s}`));
                }
            }

            if (coincidenciasPorTermino > 0) {
                hallazgos.push(''); // Añadir línea en blanco para separar
                
                // Actualizar contador global de hallazgos por string
                hallazgosPorString[stringBuscado] = (hallazgosPorString[stringBuscado] || 0) + coincidenciasPorTermino;

                // Registrar hallazgos para el objeto JSON de resultados
                archivoResult.coincidencias.push({
                    texto: stringBuscado,
                    cantidad: coincidenciasPorTermino,
                    fragmentos: fragmentosConPagina
                });
                archivoResult.totalCoincidencias += coincidenciasPorTermino;
            }
        }

    } catch (e) {
        problemas.push(`Archivo: '${nombreBase}' -> ERROR: No se pudo procesar como PDF. Razón: ${e.message}`);
        return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'error', errorDetalle: e.message } };
    }
    return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'exito' } };
};

const procesarDocx = async (rutaArchivo, listaStrings, contextChars, hallazgosPorString) => {
    const hallazgos = [], problemas = [];
    const nombreBase = path.basename(rutaArchivo);
    const archivoResult = { archivo: nombreBase, tipo: 'DOCX', totalCoincidencias: 0, coincidencias: [] };

    try {
        const { value } = await mammoth.extractRawText({ path: rutaArchivo });
        if (!value || !value.trim()) {
            problemas.push(`Archivo: '${nombreBase}' (DOCX) -> Advertencia: Archivo DOCX vacío o sin texto extraíble.`);
            return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'advertencia', errorDetalle: 'Archivo vacío o sin texto extraíble.' } };
        }

        for (const stringBuscado of listaStrings) {
            const snippets = _getContextSnippets(value, stringBuscado, contextChars);
            if (snippets.length > 0) {
                hallazgos.push(`\nArchivo: '${nombreBase}' (DOCX) -> Encontrado: '${stringBuscado}'`);
                hallazgos.push(...snippets.map(s => `  └─ ${s}`));
                hallazgos.push('');
                hallazgosPorString[stringBuscado] = (hallazgosPorString[stringBuscado] || 0) + snippets.length;

                archivoResult.coincidencias.push({
                    texto: stringBuscado,
                    cantidad: snippets.length,
                    fragmentos: snippets
                });
                archivoResult.totalCoincidencias += snippets.length;
            }
        }
    } catch (e) {
        problemas.push(`Archivo: '${nombreBase}' -> ERROR: No se pudo procesar como DOCX. Razón: ${e.message}`);
        return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'error', errorDetalle: e.message } };
    }
    return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'exito' } };
};

const procesarExcel = async (rutaArchivo, listaStrings, contextChars, hallazgosPorString) => {
    const hallazgos = [], problemas = [];
    const nombreBase = path.basename(rutaArchivo);
    const archivoResult = { archivo: nombreBase, tipo: 'Excel', totalCoincidencias: 0, coincidencias: [] };

    try {
        const workbook = xlsx.readFile(rutaArchivo);
        let hojasVacias = true;

        if (workbook.SheetNames.length === 0) {
            problemas.push(`Archivo: '${nombreBase}' (Excel) -> Advertencia: Archivo Excel sin hojas.`);
            return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'advertencia', errorDetalle: 'Archivo Excel sin hojas.' } };
        }

        for (const nombreHoja of workbook.SheetNames) {
            const hoja = workbook.Sheets[nombreHoja];
            const data = xlsx.utils.sheet_to_json(hoja, { header: 1, defval: "" });

            const hojaTieneDatos = data.flat().some(cell => String(cell).trim().length > 0);
            if (hojaTieneDatos) hojasVacias = false;

            for (let filaIdx = 0; filaIdx < data.length; filaIdx++) {
                for (let colIdx = 0; colIdx < data[filaIdx].length; colIdx++) {
                    const valorCelda = String(data[filaIdx][colIdx]);
                    if (valorCelda && valorCelda.trim()) {
                        for (const stringBuscado of listaStrings) {
                            const snippets = _getContextSnippets(valorCelda, stringBuscado, contextChars);
                            if (snippets.length > 0) {
                                const celdaRef = `${xlsx.utils.encode_col(colIdx)}${filaIdx + 1}`;
                                hallazgos.push(`\nArchivo: '${nombreBase}', Hoja: '${nombreHoja}', Celda: ${celdaRef} -> Encontrado: '${stringBuscado}'`);
                                hallazgos.push(...snippets.map(s => `  └─ ${s}`));
                                hallazgos.push('');
                                hallazgosPorString[stringBuscado] = (hallazgosPorString[stringBuscado] || 0) + snippets.length;

                                let matchEntry = archivoResult.coincidencias.find(c => c.texto === stringBuscado);
                                if (!matchEntry) {
                                    matchEntry = { texto: stringBuscado, cantidad: 0, fragmentos: [] };
                                    archivoResult.coincidencias.push(matchEntry);
                                }
                                matchEntry.cantidad += snippets.length;
                                matchEntry.fragmentos.push(...snippets.map(s => `Hoja: '${nombreHoja}', Celda: ${celdaRef} - ${s}`));
                                archivoResult.totalCoincidencias += snippets.length;
                            }
                        }
                    }
                }
            }
        }
        if (hojasVacias) {
            problemas.push(`Archivo: '${nombreBase}' (Excel) -> Advertencia: Archivo Excel sin datos en ninguna hoja.`);
            return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'advertencia', errorDetalle: 'Archivo sin datos en ninguna hoja.' } };
        }
    } catch (e) {
        problemas.push(`Archivo: '${nombreBase}' -> ERROR: No se pudo procesar como Excel. Razón: ${e.message}`);
        return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'error', errorDetalle: e.message } };
    }
    return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'exito' } };
};

const procesarTxt = async (rutaArchivo, listaStrings, contextChars, hallazgosPorString) => {
    const hallazgos = [], problemas = [];
    const nombreBase = path.basename(rutaArchivo);
    const archivoResult = { archivo: nombreBase, tipo: 'TXT', totalCoincidencias: 0, coincidencias: [] };

    try {
        const contenido = await fs.readFile(rutaArchivo, 'utf-8');
        if (!contenido || !contenido.trim()) {
            problemas.push(`Archivo: '${nombreBase}' (TXT) -> Advertencia: Archivo de texto vacío.`);
            return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'advertencia', errorDetalle: 'Archivo de texto vacío.' } };
        }
        const lineas = contenido.split(/\r?\n/);
        for (let i = 0; i < lineas.length; i++) {
            const linea = lineas[i];
            if (!linea.trim()) continue;
            for (const stringBuscado of listaStrings) {
                const snippets = _getContextSnippets(linea, stringBuscado, contextChars);
                if (snippets.length > 0) {
                    hallazgos.push(`\nArchivo: '${nombreBase}', Línea: ${i + 1} -> Encontrado: '${stringBuscado}'`);
                    hallazgos.push(...snippets.map(s => `  └─ ${s}`));
                    hallazgos.push('');
                    hallazgosPorString[stringBuscado] = (hallazgosPorString[stringBuscado] || 0) + snippets.length;

                    let matchEntry = archivoResult.coincidencias.find(c => c.texto === stringBuscado);
                    if (!matchEntry) {
                        matchEntry = { texto: stringBuscado, cantidad: 0, fragmentos: [] };
                        archivoResult.coincidencias.push(matchEntry);
                    }
                    matchEntry.cantidad += snippets.length;
                    matchEntry.fragmentos.push(...snippets.map(s => `Línea: ${i + 1} - ${s}`));
                    archivoResult.totalCoincidencias += snippets.length;
                }
            }
        }
    } catch (e) {
        problemas.push(`Archivo: '${nombreBase}' -> ERROR: No se pudo procesar como TXT. Razón: ${e.message}`);
        return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'error', errorDetalle: e.message } };
    }
    return { hallazgosTexto: hallazgos, problemasTexto: problemas, archivoResult: { ...archivoResult, estado: 'exito' } };
};

// --- Función principal exportada ---
const generarInforme = async (carpetaEntrada, listaStrings, contextChars = 240) => {
    let hallazgosTotalesTexto = [];
    let archivosProblematicosTexto = [];
    let archivosIgnoradosLista = [];
    let resultadosPorArchivo = [];

    let totalArchivosSubidos = 0;
    let totalArchivosProcesadosConExito = 0;
    let totalArchivosConProblemas = 0;
    let totalHallazgosGlobal = 0;
    const hallazgosPorString = {};
    listaStrings.forEach(s => hallazgosPorString[s] = 0);

    const extensionesSoportadas = ['.pdf', '.docx', '.xlsx', '.xls', '.txt'];

    let archivosEnDirectorio;
    try {
        archivosEnDirectorio = await fs.readdir(carpetaEntrada);
    } catch (error) {
        console.error(`Error al leer el directorio de entrada '${carpetaEntrada}': ${error.message}`);
        throw new Error(`No se pudo acceder al directorio de archivos subidos. Verifique permisos o si la ruta es correcta. ${error.message}`);
    }

    totalArchivosSubidos = archivosEnDirectorio.length;

    for (const nombreArchivo of archivosEnDirectorio) {
        const rutaCompleta = path.join(carpetaEntrada, nombreArchivo);
        const stat = await fs.stat(rutaCompleta);
        
        if (stat.isFile()) {
            const extension = path.extname(nombreArchivo).toLowerCase();

            if (extensionesSoportadas.includes(extension)) {
                let resultadoProcesamiento;
                try {
                    if (extension === '.pdf') {
                        resultadoProcesamiento = await procesarPdf(rutaCompleta, listaStrings, contextChars, hallazgosPorString);
                    } else if (extension === '.docx') {
                        resultadoProcesamiento = await procesarDocx(rutaCompleta, listaStrings, contextChars, hallazgosPorString);
                    } else if (['.xlsx', '.xls'].includes(extension)) {
                        resultadoProcesamiento = await procesarExcel(rutaCompleta, listaStrings, contextChars, hallazgosPorString);
                    } else if (extension === '.txt') {
                        resultadoProcesamiento = await procesarTxt(rutaCompleta, listaStrings, contextChars, hallazgosPorString);
                    }

                    hallazgosTotalesTexto.push(...resultadoProcesamiento.hallazgosTexto);
                    archivosProblematicosTexto.push(...resultadoProcesamiento.problemasTexto);
                    resultadosPorArchivo.push(resultadoProcesamiento.archivoResult);

                    if (resultadoProcesamiento.archivoResult.estado === 'exito' || resultadoProcesamiento.archivoResult.estado === 'advertencia') {
                        totalArchivosProcesadosConExito++;
                        totalHallazgosGlobal += resultadoProcesamiento.archivoResult.totalCoincidencias;
                    } else {
                        totalArchivosConProblemas++;
                    }
                } catch (e) {
                    archivosProblematicosTexto.push(`Archivo: '${nombreArchivo}' -> ERROR CRÍTICO: Fallo al procesar. Razón: ${e.message}`);
                    totalArchivosConProblemas++;
                    resultadosPorArchivo.push({
                        archivo: nombreArchivo,
                        tipo: extension,
                        estado: 'error',
                        errorDetalle: e.message,
                        totalCoincidencias: 0,
                        coincidencias: []
                    });
                }
            } else {
                archivosIgnoradosLista.push(nombreArchivo);
            }
        }
    }

    // Generar reporte en texto plano
    let output = [];
    output.push("=".repeat(30) + " INFORME DE BÚSQUEDA CONTEXTUAL " + "=".repeat(30));
    output.push(`Fecha y Hora del Informe: ${new Date().toLocaleString()}`);
    output.push(`Textos Buscados: [${listaStrings.join(', ')}]`);
    output.push(`Cantidad de Caracteres de Contexto: ${contextChars} (anteriores y posteriores al texto hallado)`);
    output.push(`Extensiones de Archivo Soportadas: ${extensionesSoportadas.join(', ')}`);
    output.push("=".repeat(85));

    output.push("\n--- OCURRENCIAS HALLADAS ---");
    if (hallazgosTotalesTexto.length > 0) {
        output.push(...hallazgosTotalesTexto);
    } else {
        output.push("No se encontraron ocurrencias de los textos buscados en los archivos procesados.");
    }

    output.push("\n\n--- ARCHIVOS PROCESADOS CON PROBLEMAS O ADVERTENCIAS ---");
    if (archivosProblematicosTexto.length > 0) {
        output.push(...archivosProblematicosTexto);
    } else {
        output.push("Todos los archivos soportados fueron analizados sin errores ni advertencias significativas.");
    }

    output.push("\n\n--- ARCHIVOS NO SOPORTADOS E IGNORADOS ---");
    output.push(`Total de archivos ignorados: ${archivosIgnoradosLista.length}\n`);
    if (archivosIgnoradosLista.length > 0) {
        archivosIgnoradosLista.sort().forEach(archivo => output.push(`- ${archivo}`));
    } else {
        output.push("No se encontraron archivos con formatos no soportados.");
    }

    output.push("\n\n" + "=".repeat(36) + " RESUMEN FINAL " + "=".repeat(36));
    output.push(`Total de archivos en el directorio de subida: ${totalArchivosSubidos}`);
    output.push(`Total de archivos procesados con éxito (incluye advertencias): ${totalArchivosProcesadosConExito}`);
    output.push(`Total de archivos ignorados por formato no válido: ${archivosIgnoradosLista.length}`);
    output.push(`Total de archivos con problemas o errores (no pudieron ser procesados): ${totalArchivosConProblemas}`);
    output.push(`Total de coincidencias encontradas: ${totalHallazgosGlobal}`);
    output.push(`Contexto devuelto (caracteres): ${contextChars}`);
    output.push("\nTotal de hallazgos por cada texto buscado:");
    listaStrings.forEach(s => {
        output.push(`  - '${s}': ${hallazgosPorString[s] || 0}`);
    });
    output.push("=".repeat(85));

    const reporteTexto = output.join('\n');

    // Preparar respuesta JSON
    const jsonResponse = {
        resumen: {
            totalArchivos: totalArchivosSubidos,
            procesados: totalArchivosProcesadosConExito,
            ignorados: archivosIgnoradosLista.length,
            conProblemas: totalArchivosConProblemas,
            totalCoincidencias: totalHallazgosGlobal,
            coincidenciasPorPalabra: hallazgosPorString,
            caracteresContexto: contextChars,
            extensionesSoportadas: extensionesSoportadas,
            textosBuscados: listaStrings
        },
        resultados: resultadosPorArchivo.filter(file => file.totalCoincidencias > 0 || file.estado === 'error' || file.estado === 'advertencia')
    };

    return {
        reporteTexto,
        jsonResponse,
        totalArchivosSubidos,
        totalArchivosProcesadosConExito,
        totalArchivosIgnorados: archivosIgnoradosLista.length,
        totalArchivosConProblemas,
        totalHallazgos: totalHallazgosGlobal,
        hallazgosPorString,
        contextChars
    };
};

// Exportar funciones
module.exports = {
    generarInforme
};