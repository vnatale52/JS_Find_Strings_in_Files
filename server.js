const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs').promises;
const session = require('express-session');
const { generarInforme } = require('./buscador-core.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la carpeta de subidas
const UPLOAD_FOLDER = path.join(__dirname, 'uploads');

// Asegurarse de que el directorio de subidas exista al iniciar el servidor
fs.mkdir(UPLOAD_FOLDER, { recursive: true })
    .then(() => console.log(`Directorio de subidas '${UPLOAD_FOLDER}' listo.`))
    .catch(err => console.error(`Error al crear el directorio de subidas '${UPLOAD_FOLDER}': ${err.message}`));

// Middleware para servir archivos estáticos (incluyendo index.html, style.css, etc.)
app.use(express.static(path.join(__dirname, 'static')));

// Middleware para parsear datos de formularios (URL-encoded y JSON)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuración de la sesión para guardar el informe entre solicitudes
app.use(session({
    secret: process.env.SESSION_SECRET || 'una-clave-secreta-muy-dificil-de-adivinar-en-nodejs-y-mas-segura',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 60 * 1000,
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax' // Añadido para compatibilidad entre navegadores y seguridad
    }
}));

// Configuración de Multer para la subida de archivos
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        // Generar un directorio temporal único por solicitud para los archivos
        if (!req.tempDir) {
            req.tempDir = path.join(UPLOAD_FOLDER, `upload-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
            try {
                await fs.mkdir(req.tempDir, { recursive: true });
            } catch (err) {
                console.error(`Error al crear el directorio temporal ${req.tempDir}: ${err.message}`);
                return cb(new Error('No se pudo crear el directorio de subida temporal.'));
            }
        }
        cb(null, req.tempDir);
    },
    filename: (req, file, cb) => {
        // Para manejar nombres de archivo con caracteres especiales
        const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, originalname);
    }
});

// Límite de tamaño de archivo: 128 MB, máximo 50 archivos
const upload = multer({
    storage: storage,
    limits: { 
        fileSize: 128 * 1024 * 1024, // 128 MB
        files: 50
    },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.pdf', '.docx', '.xlsx', '.xls', '.txt'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipo de archivo no permitido: ${ext}. Solo se permiten ${allowedExtensions.join(', ')}`), false);
        }
    }
});

// Middleware para eliminar el directorio temporal después de cada solicitud que use multer
app.use(async (req, res, next) => {
    res.on('finish', async () => {
        if (req.tempDir) {
            try {
                // Pequeño retardo para asegurar que los archivos hayan sido leídos si es necesario
                await new Promise(resolve => setTimeout(resolve, 100)); 
                await fs.rm(req.tempDir, { recursive: true, force: true });
                console.log(`Directorio temporal eliminado: ${req.tempDir}`);
            } catch (err) {
                console.error(`Error al eliminar el directorio temporal ${req.tempDir}: ${err.message}`);
            }
        }
    });
    next();
});

// Ruta principal, sirve el archivo HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Ruta para manejar la búsqueda de archivos
app.post('/buscar', upload.array('files'), async (req, res) => {
    const files = req.files;
    const searchStringsRaw = req.body.search_strings;
    let context_chars = parseInt(req.body.context_chars, 10); // Asegúrate de usar base 10
    const tempDir = req.tempDir;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No se seleccionó ningún archivo para subir o hubo un problema con la subida.' });
    }
    
    if (!searchStringsRaw || !searchStringsRaw.trim()) {
        return res.status(400).json({ error: 'Debes introducir al menos un texto para buscar.' });
    }

    // Validar y ajustar context_chars
    if (isNaN(context_chars) || context_chars < 0 || context_chars > 1000) {
        context_chars = 240; // Valor por defecto
        console.warn(`Valor de caracteres de contexto inválido (${req.body.context_chars}). Se usará el valor por defecto: ${context_chars}`);
    }

    const listaStrings = searchStringsRaw.split(';').map(s => s.trim()).filter(s => s);
    if (listaStrings.length === 0) {
        return res.status(400).json({ error: 'La lista de textos a buscar está vacía después de procesar.' });
    }

    try {
        const informeResult = await generarInforme(tempDir, listaStrings, context_chars);
        req.session.informeResult = informeResult; // Guarda el informe en la sesión
        res.json(informeResult.jsonResponse);
    } catch (error) {
        console.error("Error al generar el informe en /buscar:", error);
        res.status(500).json({ error: 'Ocurrió un error interno al procesar los archivos. Por favor, inténtelo de nuevo.', details: error.message });
    }
});

// Manejo de errores de Multer (middleware de errores)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Uno o más archivos exceden el límite de tamaño de 128 MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Ha excedido el número máximo de archivos permitidos (50).' });
        }
        // Para otros errores de Multer no específicos aquí
        return res.status(400).json({ error: `Error de subida: ${err.message}` });
    } else if (err) {
        // Errores generales que no son de Multer, por ejemplo, el error de fileFilter
        return res.status(400).json({ error: `Error en la subida de archivos: ${err.message}` });
    }
    next(err); // Pasa el error al siguiente middleware si no lo manejamos aquí
});

// Ruta para descargar el informe completo en formato TXT
app.get('/descargar_reporte', (req, res) => {
    const informeResult = req.session.informeResult;
    if (!informeResult || !informeResult.reporteTexto) {
        return res.status(404).send('No hay ningún informe de texto para descargar. Realice una búsqueda primero.');
    }
    const reporte = informeResult.reporteTexto;
    res.setHeader('Content-disposition', 'attachment; filename=informe_busqueda_contexto.txt');
    res.setHeader('Content-type', 'text/plain; charset=UTF-8');
    res.send(reporte);
});

// Ruta para descargar el informe JSON
app.get('/descargar_reporte_json', (req, res) => {
    const informeResult = req.session.informeResult;
    if (!informeResult || !informeResult.jsonResponse) {
        return res.status(404).send('No hay ningún informe JSON para descargar. Realice una búsqueda primero.');
    }
    const jsonReport = informeResult.jsonResponse;
    res.setHeader('Content-disposition', 'attachment; filename=informe_busqueda_contexto.json');
    res.setHeader('Content-type', 'application/json; charset=UTF-8');
    res.json(jsonReport);
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
    console.log(`Accede a la aplicación en http://localhost:${PORT}`);
});