const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs/promises');
const session = require('express-session');
const { generarInforme } = require('./buscador-core.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la plantilla EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware para servir archivos estáticos (audio, css, etc.)
app.use(express.static(path.join(__dirname, 'static')));

// Middleware para parsear datos de formularios
app.use(express.urlencoded({ extended: true }));

// Configuración de la sesión para guardar el informe
app.use(session({
    secret: 'una-clave-secreta-muy-dificil-de-adivinar-en-nodejs',
    resave: false,
    saveUninitialized: true,
}));

// Configuración de Multer para la subida de archivos
const UPLOAD_FOLDER = 'uploads';
fs.mkdir(UPLOAD_FOLDER, { recursive: true }); // Asegurarse de que el directorio exista

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Crea un directorio temporal único para cada solicitud
        const tempDir = path.join(UPLOAD_FOLDER, Date.now().toString());
        fs.mkdir(tempDir, { recursive: true }).then(() => {
            req.tempDir = tempDir; // Guardamos la ruta temporal en el objeto request
            cb(null, tempDir);
        });
    },
    filename: (req, file, cb) => {
        // Usar el nombre original del archivo de forma segura
        cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 128 * 1024 * 1024 } // Límite de 128 MB
});

// Rutas de la aplicación
app.get('/', (req, res) => {
    res.render('index', { messages: req.session.messages || [] });
    req.session.messages = []; // Limpiar mensajes después de mostrarlos
});

app.post('/buscar', upload.array('files'), async (req, res) => {
    const files = req.files;
    const searchStringsRaw = req.body.search_strings;
    let context_chars = parseInt(req.body.context_chars, 10);
    const tempDir = req.tempDir;

    // Validaciones
    if (isNaN(context_chars) || context_chars < 0 || context_chars > 1000) {
        context_chars = 240; // Valor por defecto
    }

    if (!files || files.length === 0) {
        req.session.messages = [{ category: 'danger', text: 'No se seleccionó ningún archivo.' }];
        return res.redirect('/');
    }
    
    if (!searchStringsRaw || !searchStringsRaw.trim()) {
        req.session.messages = [{ category: 'danger', text: 'Debes introducir al menos un texto para buscar.' }];
        return res.redirect('/');
    }

    const listaStrings = searchStringsRaw.split(';').map(s => s.trim()).filter(s => s);
    
    try {
        const reporteStr = await generarInforme(tempDir, listaStrings, context_chars);
        req.session.reporte = reporteStr; // Guardar el informe en la sesión
        res.render('resultados', { report_content: reporteStr });
    } catch (error) {
        console.error("Error al generar el informe:", error);
        req.session.messages = [{ category: 'danger', text: 'Ocurrió un error al procesar los archivos.' }];
        res.redirect('/');
    } finally {
        // Limpiar el directorio temporal después de procesar
        if (tempDir) {
            fs.rm(tempDir, { recursive: true, force: true });
        }
    }
});

app.get('/descargar_reporte', (req, res) => {
    const reporte = req.session.reporte || 'No hay ningún informe para descargar.';
    res.setHeader('Content-disposition', 'attachment; filename=informe_busqueda_contexto.txt');
    res.setHeader('Content-type', 'text/plain');
    res.charset = 'UTF-8';
    res.write(reporte);
    res.end();
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});