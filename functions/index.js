/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const nsfwjs = require("nsfwjs");
const busboy = require('busboy');
const os = require('os');
const path = require('path');
const fs = require('fs')
const tf = require('@tensorflow/tfjs-node');

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

exports.helloWorld = onRequest(async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(400).json({ error: 'Method not allowed' });
    }

    const bb = busboy({ headers: req.headers });

    let imageFileName;
    let imageFilePath;

    bb.on('file', (name, file, info) => {
        const { filename, encoding, mimeType } = info;

        if (mimeType !== 'image/jpeg' && mimeType !== 'image/jpg' && mimeType !== 'image/png') {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        // Generate a unique file name for the uploaded image
        const randomName = Math.random().toString(36).substring(2);
        const imageExtension = path.extname(filename);
        imageFileName = `${randomName}${imageExtension}`;

        // Create a temporary file path for the uploaded image
        imageFilePath = path.join(os.tmpdir(), imageFileName);

        // Stream the file to the temporary path
        file.pipe(fs.createWriteStream(imageFilePath));
    });

    bb.on('finish', () => {
        if (!imageFilePath) {
            return res.status(400).json({ error: `No image provided: ${err}` });
        }

        fs.readFile(imageFilePath, async (err, buffer) => {
            if (err) {
                return res.status(500).json({ error: err });
            }

            const image = await tf.node.decodeImage(buffer, 3);

            const preds = await nsfwjs.load()
            .then((model) => {
                return model.classify(image)
            }).then((predictions) => {
                image.dispose();
                return predictions
            }).catch((err) => {
                res.status(400).json({ error: `Error while classifying image: ${err}` });
            });
        
            // Send a response indicating the successful upload
            res.status(200).json(preds);
        });
    });

    bb.end(req.rawBody);
});
