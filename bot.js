// This code is written for a Node.js server environment and uses the local file system (fs).
// It must be hosted on a Node.js platform like Render, Heroku, or a VPS.

// ----------------- Dependencies -----------------
const fs = require('fs');
const path = require('path');
const TeleBot = require('telebot');
// Note: To run this, you must run 'npm install telebot' first (handled by the deployment platform).

// ----------------- Configuration -----------------
const BOT_TOKEN = "7991881414:AAEYfZDmbdoEXVMqXyDkd5TQa4t3TGJoKMU"; 
const ADMIN_ID = 7404076592; 
const MIN_WITHDRAWAL = 5000; // Minimum points required for any withdrawal request.

// 🛠️ FIX 1: Use a safe, temporary directory (Render/Heroku compatible) for file storage
const DATA_FOLDER = process.env.TMPDIR || process.env.TEMP || path.join(__dirname, 'data');

// Ensure data folder exists (Wrapped in try/catch to prevent startup crash)
try {
    if (!fs.existsSync(DATA_FOLDER)) {
        fs.mkdirSync(DATA_FOLDER);
        console.log(`Created data folder: ${DATA_FOLDER}`);
    }
} catch (e) {
    console.error(`CRITICAL: Failed to create DATA_FOLDER at ${DATA_FOLDER}. The application will likely crash if it tries to write data.`);
}

// File paths
const USERS_FILE = path.join(DATA_FOLDER, 'users.json');
const TASKS_FILE = path.join(DATA_FOLDER, 'tasks.json');
const WITHDRAWS_FILE = path.join(DATA_FOLDER, 'withdraws.json');

// Helper to read/write JSON
function readJSON(file) {
    try {
        if (!fs.existsSync(file)) return [];
        const data = fs.readFileSync(file, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading ${file}:`, error.message);
        return []; 
    }
}
function writeJSON(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error writing to ${file}:`, error.message);
    }
}

// 🛠️ FIX 2: Initialize JSON files only if the directory is successfully writable.
const initializeFiles = () => {
    try {
        if (!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, []);
        if (!fs.existsSync(TASKS_FILE)) writeJSON(TASKS_FILE, []);
        if (!fs.existsSync(WITHDRAWS_FILE)) writeJSON(WITHDRAWS_FILE, []);
    } catch (e) {
        console.error("CRITICAL: Failed to initialize JSON files. Check folder permissions.");
    }
}
initializeFiles();

// ----------------- Bot Setup -----------------
const bot = new TeleBot(BOT_TOKEN);

// ----------------- Core Logic Helpers -----------------

// Helper to safely get user ID as string
const getUserIdString = (id) => id.toString();

function getUser(userId) {
  const userIdStr = getUserIdString(userId);
  const users = readJSON(USERS_FILE);
  return users.find(u => u.userId === userIdStr);
}

function saveUser(user) {
  const users = readJSON(USERS_FILE);
  // Ensure we are working with the string version of the userId
  user.userId = getUserIdString(user.userId);
  
  const index = users.findIndex(u => u.userId === user.userId);
  if (index === -1) users.push(user);
  else users[index] = user;
  
  writeJSON(USERS_FILE, users);
}

// Function to add (positive number) or subtract (negative number) points
function addPoints(userId, points) {
  let user = getUser(userId);
  if (!user) {
    console.log(`Attempted to modify points for non-existent user: ${userId}`);
    return false;
  }
  user.points += points;
  saveUser(user);
  return true;
}

function getLevel(user) {
  return Math.floor(user.points / 500) + 1;
}

// ----------------- Bot Commands -----------------

bot.on(['/start'], (msg) => {
  const userId = getUserIdString(msg.from.id);
  let user = getUser(userId);
  
  // Check for referral
  const startPayload = msg.text.split(' ')[1]; // Get the part after /start
  let initialPoints = 100;

  if (!user) {
    // New user registration
    user = { userId, username: msg.from.username || 'Anonymous', points: initialPoints };
    saveUser(user);
    
    let welcomeMessage = `🎉 Welcome to BinGo! You got ${initialPoints} points.`;

    if (startPayload && startPayload !== userId) {
        // Referral logic: Grant bonus to referrer
        const referrerId = startPayload;
        const referrerExists = addPoints(referrerId, 50); // Add 50 points to referrer
        if (referrerExists) {
            welcomeMessage += `\n\nBonus: You were referred by user ${referrerId} and they received 50 points!`;
        }
    }
    
    bot.sendMessage(userId, welcomeMessage);
  } else {
    bot.sendMessage(userId, `Welcome back! You have ${user.points} points. Level: ${getLevel(user)}`);
  }
});

bot.on(['/points'], (msg) => {
  const user = getUser(msg.from.id);
  if (!user) return bot.sendMessage(msg.from.id, "You are not registered yet. Use /start.");
  bot.sendMessage(msg.from.id, `You have ${user.points} points. Level: ${getLevel(user)}`);
});

bot.on(['/leaderboard'], (msg) => {
  const users = readJSON(USERS_FILE)
    .sort((a,b)=>b.points-a.points)
    .slice(0,10);
  
  let text = "🏆 Top Players:\n";
  users.forEach((u,i) => {
    // Display username if available, otherwise use a generic name
    const displayUsername = u.username && u.username !== 'Anonymous' ? `@${u.username}` : `User ${u.userId.substring(0, 4)}...`;
    text += `${i+1}. ${displayUsername} — ${u.points} pts\n`;
  });
  bot.sendMessage(msg.from.id, text);
});

// Enforces 5000 point minimum withdrawal and deducts points immediately.
bot.on(['/withdraw'], (msg) => {
    const userId = getUserIdString(msg.from.id);
    const user = getUser(userId);
    if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.");

    const parts = msg.text.trim().split(/\s+/);
    if (parts.length < 2) {
        return bot.sendMessage(userId, 
            `💰 Usage: /withdraw <amount>\nMinimum withdrawal is ${MIN_WITHDRAWAL} points.\nYour current points: ${user.points}`
        );
    }
    
    const requestedAmount = parseInt(parts[1], 10);

    // 1. Check for valid amount
    if (isNaN(requestedAmount) || requestedAmount <= 0) {
        return bot.sendMessage(userId, "❌ Invalid amount. Please enter a positive number.");
    }
    
    // 2. Enforce minimum withdrawal limit
    if (requestedAmount < MIN_WITHDRAWAL) {
        return bot.sendMessage(userId, 
            `❌ Withdrawal rejected. The minimum withdrawal amount is ${MIN_WITHDRAWAL} points.`
        );
    }

    // 3. Check for sufficient funds
    if (user.points < requestedAmount) {
        return bot.sendMessage(userId, 
            `❌ You only have ${user.points} points. You cannot withdraw ${requestedAmount} points.`
        );
    }

    // Deduction: Subtract the requested amount
    addPoints(userId, -requestedAmount); 
    
    // Record request
    const withdraws = readJSON(WITHDRAWS_FILE);
    const newRequest = { 
        id: Date.now().toString(), 
        userId: user.userId, 
        username: user.username, 
        amount: requestedAmount, // Record the amount
        status: "pending", 
        timestamp: new Date().toISOString()
    };
    withdraws.push(newRequest);
    writeJSON(WITHDRAWS_FILE, withdraws);
    
    // Notify user with new balance
    const updatedUser = getUser(userId); // Fetch updated user data
    bot.sendMessage(userId, 
        `✅ Success! Your request to withdraw ${requestedAmount} points has been sent. Your new balance is ${updatedUser.points} points.`
    );
    
    // Notify Admin
    bot.sendMessage(ADMIN_ID, 
        `💰 NEW Withdraw Request:\nUser: ${user.username} (ID: ${user.userId})\nAmount: ${requestedAmount} points\nRequest ID: ${newRequest.id}`
    );
});

bot.on(['/referral'], (msg) => {
  // We use JUDEMONIE here, based on the original request's link structure.
  const botUsername = bot.options.username || 'JUDEMONIE'; 
  const refLink = `https://t.me/${botUsername}?start=${msg.from.id}`;
  bot.sendMessage(msg.from.id, `Share this link to get a referral bonus when a new user joins using it:\n${refLink}`);
});

// ----------------- Admin Commands -----------------
bot.on(['/addpoints'], (msg) => {
  if (getUserIdString(msg.from.id) !== getUserIdString(ADMIN_ID)) {
      return bot.sendMessage(msg.from.id, "🚫 You are not authorized to use this command.");
  }
  
  const parts = msg.text.trim().split(/\s+/);
  if (parts.length !== 3) return bot.sendMessage(msg.from.id, "Usage: /addpoints <userId> <points>");
  
  const targetUserId = parts[1];
  const pointsToAdd = parseInt(parts[2], 10);

  if (isNaN(pointsToAdd) || pointsToAdd <= 0) {
      return bot.sendMessage(msg.from.id, "Points must be a positive number.");
  }

  const success = addPoints(targetUserId, pointsToAdd);
  if (success) {
      bot.sendMessage(msg.from.id, `✅ Added ${pointsToAdd} points to user ${targetUserId}`);
      bot.sendMessage(targetUserId, `🎉 You have been awarded ${pointsToAdd} points by the Admin!`);
  } else {
      bot.sendMessage(msg.from.id, `❌ Failed to find user with ID: ${targetUserId}`);
  }
});

bot.on(['/completewithdraw'], (msg) => {
  if (getUserIdString(msg.from.id) !== getUserIdString(ADMIN_ID)) {
      return bot.sendMessage(msg.from.id, "🚫 You are not authorized to use this command.");
  }
  
  const parts = msg.text.trim().split(/\s+/);
  if (parts.length !== 2) return bot.sendMessage(msg.from.id, "Usage: /completewithdraw <withdrawId>");

  const withdraws = readJSON(WITHDRAWS_FILE);
  const index = withdraws.findIndex(w => w.id === parts[1] && w.status === "pending");
  
  if (index === -1) return bot.sendMessage(msg.from.id, "Withdraw ID not found or already completed.");

  const withdrawRequest = withdraws[index];
  withdrawRequest.status = "completed";
  writeJSON(WITHDRAWS_FILE, withdraws);

  bot.sendMessage(msg.from.id, `✅ Withdraw ID ${withdrawRequest.id} marked as completed.`);
  bot.sendMessage(withdrawRequest.userId, `✅ Your withdraw request (${withdrawRequest.id} for ${withdrawRequest.amount} points) has been successfully completed!`);
});

// ----------------- Start Bot -----------------
bot.start()
    .then(() => console.log("BinGo Bot is running and connected to Telegram."))
    .catch(err => console.error("FATAL ERROR: Could not start bot:", err));

