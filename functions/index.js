const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// Get user and add a custom claim (accepted).
// Only add the claim if the is accepted and verified
// Needs to be called after the database has been updated
// when assigning the accepted role.
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
          if (accepted === true && user.emailVerified === true) {
            return admin.auth().setCustomUserClaims(user.uid, {
              accepted: true,
            }).then(() => {
              return true;
            });
          } else {
            // User not accepted yet or email is not verified.
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
