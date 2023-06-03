const {onRequest} = require("firebase-functions/v2/https");
const nsfwjs = require("nsfwjs");
const os = require('os');
const path = require('path');
const fs = require('fs')
const tf = require('@tensorflow/tfjs-node');
const express = require('express');
const admin = require('firebase-admin');
const busboy = require('busboy');
const uuid = require('uuid')

const NSFW_THRESHOLD = 0.15;
const BUCKET_NAME = "recloset-99e15"

!admin.apps.length 
? admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: `gs://${BUCKET_NAME}`
}) 
: admin.app();


const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NSFW model for content moderation
const nsfwModel = nsfwjs.load();
// Firestore bucket
const bucket = admin.storage().bucket();

app.post('/', async (req, res) => {
    const bb = busboy({ headers: req.headers });

    // TODO: In future, can add checks for item description concurrently as well.
    const imageFilePromises = [];
    let formFields = {};

    bb.on('file', (name, file, info) => {
        const { filename, encoding, mimeType } = info;

        if (mimeType !== 'image/jpeg' && mimeType !== 'image/jpg' && mimeType !== 'image/png') {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        // Generate a unique filename for the uploaded image
        const randomName = Math.random().toString(36).substring(2);
        const imageExtension = path.extname(filename);
        const imageFileName = `${randomName}${imageExtension}`;

        // Create a temporary file path for the uploaded image
        const imageFilePath = path.join(os.tmpdir(), imageFileName);

        // Stream the file to the temporary path
        const writeStream = fs.createWriteStream(imageFilePath);
        file.pipe(writeStream);

            // Create a promise to read and process the uploaded image file
        const imageFilePromise = new Promise((resolve, reject) => {
            writeStream.on('finish', () => {
            fs.readFile(imageFilePath, async (err, buffer) => {
                if (err) {
                reject(err);
                } else {
                    const image = await tf.node.decodeImage(buffer, 3);
        
                    const model = await nsfwModel

                    const score = model.classify(image)
                    .then((predictions) => {
                        image.dispose();
                        const totalNsfwScore = predictions.reduce((acc, curr) => {
                            if (curr.className === "Neutral") {
                            return acc;
                            } else {
                            return acc + curr.probability;
                            }
                        }, 0);
                        return { filename, buffer, totalNsfwScore };
                    })
                    .catch((err) => {
                        reject(err);
                    });
        
                    // Resolve with the predictions for this image
                    resolve(score);
                }
    
                // Delete the temporary file
                fs.unlinkSync(imageFilePath);
            });
            });
    
            writeStream.on('error', (err) => {
            reject(err);
            });
        });
    
        // Add the image file promise to the array
        imageFilePromises.push(imageFilePromise);
        });

    bb.on('field', (fieldname, value) => {
        formFields[fieldname] = value;
    });

    bb.on('finish', () => {
        if (imageFilePromises.length === 0) {
            return res.status(400).json({ error: 'No images provided' });
        }
    
        // Wait for all image file promises to resolve
        Promise.all(imageFilePromises)
        .then(async (results) => {
            const nsfwImages = results.filter((result) => {
                return result.totalNsfwScore > NSFW_THRESHOLD;
            });

            if (nsfwImages.length > 0) {
                return res.status(400).json({ error: 'NSFW images detected' });
            } else {
                // console.log(results)
                // Upload approved images to a storage bucket
                const imageUrls = await Promise.all(results.map(async ({ filename, buffer }) => {
                    const fileExtension = path.extname(filename);
                    const uniqueFilename = `${uuid.v4()}${fileExtension}`;
                    const file = bucket.file(`approved-images/${uniqueFilename}`);

                    // Determine the content type based on the file extension
                    let contentType;
                    if (fileExtension === '.jpg' || fileExtension === '.jpeg') {
                        contentType = 'image/jpeg';
                    } else if (fileExtension === '.png') {
                        contentType = 'image/png';
                    } else {
                        contentType = 'application/octet-stream'; // default content type
                    }
        
                    // Upload the image buffer to the storage bucket
                    await file.save(buffer, {
                        metadata: { contentType: contentType }
                    });

                    await file.makePublic();
        
                    // Return the image URL
                    const imageUrl = `https://storage.googleapis.com/${BUCKET_NAME}/approved-images/${uniqueFilename}`;

                    return imageUrl;
                }));

                const itemData = {
                    ...formFields,
                    images: imageUrls
                };

                const firestore = admin.firestore();
                await firestore.collection('approvedItems').add(itemData);
                return res.status(200).json({ message: 'Item added successfully!', itemData });
            }
        })
        .catch((err) => {
            return res.status(400).json({ error: `Error while processing images: ${err}` });
        });

    });

    bb.end(req.rawBody);
});

exports.checkImage = onRequest(app);