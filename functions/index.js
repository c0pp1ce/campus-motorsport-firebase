const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios").default;
const UrlSearchParams = require("url-search-params");
const Fs = require("fs");
const Path = require("path");
const os = require("os");
admin.initializeApp();

// Get user and add a custom claim (accepted).
exports.addAcceptedRole = functions.https.onCall((data, context) => {
  if (context.auth === null || context.auth.uid === null ||
    !context.auth.token.accepted) {
    return null;
  }

  return admin.auth().getUserByEmail(data.email).then((user) => {
    return admin.firestore().collection("users")
        .doc(user.uid).get().then((doc) => {
          if (!(doc && doc.exists)) {
            // Doc does not exist.
            return false;
          }
          const data = doc.data();
          if (!data) {
            // Doc is empty.
            return false;
          }
          const accepted = data.accepted;
          if (accepted === true) {
            return admin.auth().setCustomUserClaims(user.uid, {
              accepted: true,
            }).then(() => {
              return true;
            });
          } else {
            // User not accepted yet.
            return false;
          }
        }).then((result) => {
          if (result === true) {
            return {
              message: "Success!",
            };
          } else {
            return {
              message: "Failure!",
            };
          }
        });
  }).catch((err) => {
    return err;
  });
});


// Delete a user from auth if its user entry is deleted from the database.
exports.deleteUserFromAuth = functions.firestore.document("users/{uid}")
    .onDelete((snapshot, context) => {
      return admin.auth().deleteUser(context.params.uid)
          .then(() => {
            return {
              message: "User ${context.uid} has been deleted.",
            };
          }).catch((err) => {
            return err;
          });
    });


/** Retrieve images of the training grounds.
 * Each request with timeouts after 5s(image download after 10s).
 *
 * Login based on https://stackoverflow.com/questions/49367096/how-to-login-to-mediawiki-wikipedia-api-in-node-js
 * (Answer by nirinsanity)
 */
exports.getTrainingGroundsOverviews = functions.https.onCall(
    async (data, context) => {
      if (context.auth === null || context.auth.uid === null ||
        !context.auth.token.accepted) {
        console.log("Insufficent access rights.");
        return;
      }
      // API endpoint of the wiki.
      const apiUrl = "http://wiki.campus-motorsport.de/api.php";
      // Get parameters to obtain a login token.
      const getTokenParams = {
        action: "query",
        meta: "tokens",
        type: "login",
        format: "json",
      };
      try {
        // Get the token and cookie for the login.
        let response = await axios.get(apiUrl, {params: getTokenParams});
        const loginToken = response.data.query.tokens.logintoken;
        const loginCookie = response.headers["set-cookie"].join(";");
        // Return on bad response.
        if (response.status !== 200 || !loginToken || !loginCookie) {
          console.log("Could not get login token.");
          return;
        }
        console.log("Got the login token and cookies.");

        // Perform the login.
        const loginParams = {
          "action": "login",
          "lgname": "App@poc-bot",
          "lgpassword": functions.config()["poc-bot"].password,
          "lgtoken": loginToken,
          "format": "json",
        };
        const postBody = new UrlSearchParams(loginParams).toString();
        response = await axios.post(apiUrl, postBody, {
          headers: {
            Cookie: loginCookie,
          }},
        );
        // The cookie needed for any further request.
        const requestCookie = response.headers["set-cookie"].join(";");
        if (!requestCookie) {
          console.log("Login failed.");
          return;
        }
        console.log("Succesful login.");

        // Get the images from Testgelände page.
        const requestParams = {
          "action": "parse",
          "page": "Testgelände",
          "prop": "images",
          "formatversion": 2,
          "format": "json",
        };
        response = await axios.get(apiUrl, {
          headers: {
            Cookie: requestCookie,
          },
          params: requestParams,
        });
        if (response.status !== 200) {
          console.log("Could not get image infos.");
          return;
        }
        console.log("Got the image infos.");

        // Filter allowed file formats (e.g. request also returns pdf).
        const images = getAllowedImages(response.data.parse.images);
        console.log("Continue to process these images:");
        console.log(images);

        // Process the images: Get image, store it in Storage, add entry
        // in Firestore.
        for (const index in images) {
          if (index) {
            console.log("Processing an image...");
            await processImage(images[index], apiUrl, requestCookie);
          }
        }
        console.log("All images processed.");

        // Update meta info.
        console.log("Updating meta-info...");
        const date = new Date();
        const data = {
          "lastUpdate": date.toISOString(),
        };
        await admin.firestore().collection("meta-info")
            .doc("training-grounds")
            .set(data);
        console.log("meta-info updated.");
      } catch (e) {
        console.error(e);
        return;
      }
    });

/** Returns a list with the allowed images.
 * @param {array} images - List of found image files.
 * @return {array} - List of images with allowed format.
*/
function getAllowedImages(images) {
  const allowedFileFormats = ["jpg", "png", "jpeg"];
  const allowedImages = [];
  if (images) {
    // Filter response.
    for (const imageIndex in images) {
      if (imageIndex) {
        const fileParts = images[imageIndex].split(".");
        for (const fileFormatIndex in allowedFileFormats) {
          if (fileParts[fileParts.length - 1]
              .includes(allowedFileFormats[fileFormatIndex])) {
            allowedImages.push(images[imageIndex]);
            break;
          }
        }
      }
    }
  }
  return allowedImages;
}

/** Downloads the image and stores it to Storage as well as
 * adding an entry to Firestore.
 *
 * @param {string} image - Image file name
 * @param {string} apiUrl - Url to which the request is send.
 * @param {string} requestCookie - Cookie for wiki access.
 *
 * Downloading code based on
 * https://stackoverflow.com/questions/55374755/node-js-axios-download-file-stream-and-writefile
 */
async function processImage(image, apiUrl, requestCookie) {
  if (!image || !apiUrl || !requestCookie) {
    console.log("Missing parameters for processing the image");
    return;
  }
  try {
    // Get the image details.
    image = image.replace("File:", "");
    image = image.replace(" ", "_");
    console.log(image);
    let response = await axios.get(apiUrl, {
      headers: {
        Cookie: requestCookie,
      },
      params: {
        "action": "query",
        "titles": "Image:" + image,
        "prop": "imageinfo",
        "iiprop": "url",
        "format": "json",
      },
    });
    if (response.status !== 200) {
      console.log("Could not obtain image details.");
      return;
    }
    console.log("Got the image details.");

    // Retrieve the download url.
    let downloadUrl;
    const pages = response.data.query.pages;
    for (const pageId in pages) {
      if (pageId) {
        const currentUrl = pages[pageId].imageInfo[0].url;
        if (currentUrl === downloadUrl) {
          continue;
        } else {
          downloadUrl = currentUrl;
        }
      }
    }
    if (!downloadUrl) {
      console.log("Could not find the download url.");
      return;
    }
    console.log("Download url:");
    console.log(downloadUrl);

    // Download image to local tmp directory.
    const filePath = Path.resolve(os.tmpdir(), image);
    const writer = Fs.createWriteStream(filePath);
    response = await axios.get(downloadUrl, {
      headers: {
        Cookie: requestCookie,
      },
      responseType: "stream",
    });
    if (!response) {
      console.log("Image download failed.");
      return;
    }
    console.log("Saving to local dir...");
    // Make sure the file is completely written
    // bevor then is called.
    const saveStream = new Promise(
        (resolve, reject) => {
          response.data.pipe(writer);
          let error = null;
          writer.on("error", (err) => {
            error = err;
            console.error(error);
            writer.close();
            Fs.unlinkSync(filePath);
            reject(err);
          });
          writer.on("close", () => {
            if (!error) {
              console.log("Image saved locally.");
              resolve(true);
            } else {
              console.log("Failed to save image locally.");
              reject(error);
            }
          });
        },
    );
    await saveStream;

    // Upload file to Storage.
    console.log("Uploading to storage...");
    const storagePath = "images/poc-bot/" + image;
    console.log(storagePath);
    try {
      await admin.storage().bucket().upload(filePath, {
        destination: storagePath},
      );
    } catch (e) {
      console.log("Upload failed");
      console.error(e);
    } finally {
      Fs.unlinkSync(filePath);
    }
    console.log("Uploaded to storage.");

    // Add entry to Firestore. Replaces old entries based on file name.
    console.log("Adding Firestore entry...");
    const imageName = image.split(".")[0];
    const collection = admin.firestore().collection("training-grounds");
    const data = {
      "name": imageName,
      "storagePath": storagePath,
      "image": null,
    };
    const docsWithSameName = await collection
        .where("name", "==", imageName).get();
    if (docsWithSameName.length > 0) {
      console.log("Replacing old entry.");
      const doc = docsWithSameName.docs[0];
      await collection.doc(doc.id).set(data);
    } else {
      console.log("New entry");
      collection.add(data);
    }
    console.log("Image processed succesfully.");
    return;
  } catch (e) {
    console.log("Image processing failed.");
    console.error(e);
    return;
  }
}
