const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios").default;
const UrlSearchParams = require("url-search-params");
const Fs = require("fs");
const Path = require("path");
admin.initializeApp();

// Get user and add a custom claim (accepted).
exports.addAcceptedRole = functions.https.onCall((data, context) => {
  if (context.auth === null || context.auth.uid === null) {
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


/** Retrieve images of the trainig grounds.
 * Each request with timeouts after 5s(image download after 10s).
 *
 * Login based on https://stackoverflow.com/questions/49367096/how-to-login-to-mediawiki-wikipedia-api-in-node-js
 * (Answer by nirinsanity)
 */
exports.getTrainingGroundsOverviews = functions.https.onCall(
    (data, context) => {
      const apiUrl = "http://wiki.campus-motorsport.de/api.php";
      // Get parameters to obtain a login token.
      const getTokenParams = {
        action: "query",
        meta: "tokens",
        type: "login",
        format: "json",
      };

      // Get login token and cookies.
      axios.get(apiUrl, {params: getTokenParams, timeout: 5000})
          .then((response) => {
            if (response.status === 200) {
              const loginToken = response.data.query.tokens.logintoken;
              if (loginToken) {
                // Post parameters and cookie for perfoming the login.
                const loginParams = {
                  "action": "login",
                  "lgname": "App@poc-bot",
                  "lgpassword": "geot4m74429997dr739m3g7kulu5qp2j",
                  "lgtoken": loginToken,
                  "format": "json",
                };
                const postBody = new UrlSearchParams(loginParams).toString();
                const loginCookie = response.headers["set-cookie"].join(";");

                // Perform login.
                axios.post(apiUrl, postBody, {
                  headers: {
                    Cookie: loginCookie,
                  },
                  timeout: 5000,
                })
                    .then((response) => {
                      // This cookie needs to be set on any further request.
                      const requestCookie = response.headers["set-cookie"]
                          .join(";");
                      if (requestCookie) {
                        // Get the images from Testgelände page.

                        const requestParams = {
                          "action": "parse",
                          "page": "Testgelände",
                          // pageimages cant be used as it comes
                          // with 1.34 and above
                          // but this wiki is 1.28
                          "prop": "images",
                          "formatversion": 2,
                          "format": "json",
                        };

                        axios.get(apiUrl, {
                          headers: {
                            Cookie: requestCookie,
                          },
                          params: requestParams,
                          timeout: 5000,
                        })
                            .then((response) => {
                              if (response.status === 200) {
                                // Filter images by allowed formats.
                                const images = response.data.parse.images;
                                const allowedImages = getAllowedImages(images);

                                // Process the images.
                                for (const index in allowedImages) {
                                  if (index >=0 ) {
                                    processImage(allowedImages[index], apiUrl,
                                        requestCookie)
                                        .catch((error) => {
                                          throw error;
                                        });
                                  }
                                }
                              }
                            })
                            .catch((error) => {
                              throw error;
                            });
                      }
                    })
                    .catch((error) => {
                      throw error;
                    });
              }
            }
          })
          .catch((error) => {
            console.log(error);
          });
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
      if (imageIndex >= 0 && imageIndex < images.length) {
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
 * @param {string} cookie - Cookie for wiki access.
 * @return {Promise} - Returns a promise.
 *
 * Downloading code based on
 * https://stackoverflow.com/questions/55374755/node-js-axios-download-file-stream-and-writefile
 */
function processImage(image, apiUrl, cookie) {
  image = image.replace("File:", "");
  image = image.replace(" ", "_");
  // Get the original image url.
  return axios.get(apiUrl, {
    headers: {
      Cookie: cookie,
    },
    params: {
      "action": "query",
      "titles": "Image:" + image,
      "prop": "imageinfo",
      "iiprop": "url",
      "format": "json",
    },
    timeout: 5000,
  })
      .then((response) => {
        if (response.status === 200) {
          const pages = response.data.query.pages;
          for (const pageId in pages) {
            if (pageId) {
              const originalUrl = pages[pageId].imageinfo[0].url;
              if (originalUrl) {
                // Download the image.
                const filePath = Path.resolve(image);
                const writer = Fs.createWriteStream(filePath);

                axios.get(originalUrl, {
                  headers: {
                    Cookie: cookie,
                  },
                  responseType: "stream",
                  timeout: 10000,
                })
                    .then((response) => {
                      // Make sure the file is completely written
                      // bevor then is called.
                      const saveToFile = new Promise(
                          (resolve, reject) => {
                            response.data.pipe(writer);
                            let error = null;
                            writer.on("error", (err) => {
                              error = err;
                              writer.close();
                              Fs.unlinkSync(filePath);
                              reject(err);
                            });
                            writer.on("close", () => {
                              if (!error) {
                                resolve(true);
                              }
                            });
                          }
                      );
                      saveToFile
                          .then(() => {
                            // Upload file to Storage and Firestore.
                            const storagePath = "images/poc-bot/" + image;
                            admin.storage().bucket().upload(filePath,
                                {destination: storagePath})
                                .then((response) => {
                                  // Add Firestore entry.
                                  Fs.unlinkSync(filePath);
                                  console.log(response);
                                  const imageName = image.split(".")[0];
                                  const collection = admin.firestore()
                                      .collection("training-grounds");
                                  // Data of the entry.
                                  const data ={
                                    "name": imageName,
                                    "storagePath": storagePath,
                                    "image": null,
                                  };
                                  collection
                                      .where("name", "==", imageName)
                                      .get()
                                      .then((result) => {
                                        // Replace entry or add a new one
                                        // based on the image name.
                                        if (result.docs.length > 0) {
                                          collection.doc(result.docs[0].id)
                                              .set(data)
                                              .catch((error) => {
                                                throw error;
                                              });
                                        } else {
                                          collection.add(data)
                                              .catch((error) => {
                                                throw error;
                                              });
                                        }
                                      })
                                      .catch((error) => {
                                        throw error;
                                      });
                                })
                                .catch((error) => {
                                  Fs.unlinkSync(filePath);
                                  throw error;
                                });
                          })
                          .catch((error) => {
                            throw error;
                          });
                    })
                    .catch((error) => {
                      throw error;
                    });
              }
            }
          }
        }
      })
      .catch((error) => {
        throw error;
      });
}
