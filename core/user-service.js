import crypto from "crypto";
import { readDoc, writeDoc } from "./doc-store.js";

const USERS_KEY = "users";

async function loadUsers() {
  const users = await readDoc(USERS_KEY, {});
  return users && typeof users === "object" ? users : {};
}

async function saveUsers(users) {
  await writeDoc(USERS_KEY, users);
}

export async function authenticateUser(email, password, isSignUp = false) {
  if (!email || !password) throw new Error("Email and password are required");

  const cleanEmail = email.trim().toLowerCase();
  const users = await loadUsers();
  const user = users[cleanEmail];

  if (!isSignUp) {
    // LOGIN FLOW
    if (!user) throw new Error("User not found. Please sign up first.");
    if (user.password && user.password !== password) {
      throw new Error("Invalid password. Please check your credentials.");
    }
  } else {
    // SIGNUP FLOW
    if (user) {
      // User already exists — treat as login
      if (user.password && password && user.password !== password) {
        throw new Error("This email is already registered with a different password.");
      }
    } else {
      // Create new user
      const uid = "user_" + crypto.randomBytes(12).toString("hex");
      users[cleanEmail] = {
        uid,
        email: cleanEmail,
        password: password || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        watchProgress: {},
        watchlist: {}
      };
      await saveUsers(users);
    }
  }

  return {
    uid: user?.uid || users[cleanEmail].uid,
    email: user?.email || users[cleanEmail].email,
    watchProgress: (user || users[cleanEmail]).watchProgress || {},
    watchlist: (user || users[cleanEmail]).watchlist || {},
    updatedAt: (user || users[cleanEmail]).updatedAt || Date.now()
  };
}

export async function getUserData(uidOrEmail) {
  if (!uidOrEmail) return null;
  const users = await loadUsers();
  const key = String(uidOrEmail).trim().toLowerCase();

  // Search by email key or uid
  if (users[key]) return users[key];
  for (const email of Object.keys(users)) {
    if (users[email].uid === uidOrEmail) {
      return users[email];
    }
  }
  return null;
}

export async function saveUserData(uidOrEmail, { watchProgress, watchlist, email }) {
  if (!uidOrEmail) return false;
  const users = await loadUsers();
  let userKey = null;

  const key = String(uidOrEmail).trim().toLowerCase();
  if (users[key]) {
    userKey = key;
  } else {
    for (const em of Object.keys(users)) {
      if (users[em].uid === uidOrEmail) {
        userKey = em;
        break;
      }
    }
  }

  if (!userKey) {
    const targetEmail = (email || uidOrEmail).trim().toLowerCase();
    userKey = targetEmail;
    users[userKey] = {
      uid: uidOrEmail.startsWith("user_") ? uidOrEmail : `user_${Buffer.from(targetEmail).toString("hex").slice(0, 16)}`,
      email: targetEmail,
      createdAt: Date.now(),
      watchProgress: {},
      watchlist: {}
    };
  }

  const existing = users[userKey];
  if (watchProgress && typeof watchProgress === "object") {
    existing.watchProgress = {
      ...(existing.watchProgress || {}),
      ...watchProgress
    };
  }

  if (watchlist && typeof watchlist === "object") {
    existing.watchlist = {
      ...(existing.watchlist || {}),
      ...watchlist
    };
  }

  existing.updatedAt = Date.now();
  users[userKey] = existing;
  await saveUsers(users);
  return existing;
}
