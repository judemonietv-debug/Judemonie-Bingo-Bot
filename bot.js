// ----------------- Dependencies -----------------
const fs = require('fs');
const TeleBot = require('telebot');
const path = require('path');
const http = require('http'); // Required for the web server fix

// ----------------- Configuration -----------------
const BOT_TOKEN = "7991881414:AAEYfZDmbdoEXVMqXyDkd5TQa4t3TGJoKMU"; // Your Bot Token
const ADMIN_ID = 7404076592; // Your Personal Telegram ID (Judemonie)
const MIN_WITHDRAWAL = 5000;
const BOT_USERNAME = 'BinGo_bsc_bot';

// Use the environment's temporary directory for file storage (REQUIRED for Render/Heroku)
const DATA_FOLDER = process.env.TMPDIR ? path.join(process.env.TMPDIR, 'data') : path.join(__dirname, 'data');

// Ensure data folder exists
if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });

// File paths
const USERS_FILE = path.join(DATA_FOLDER, 'users.json');
const TASKS_FILE = path.join(DATA_FOLDER, 'tasks.json');
const WITHDRAWS_FILE = path.join(DATA_FOLDER, 'withdraws.json');

// Initialize JSON files if they don't exist
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');
if (!fs.existsSync(WITHDRAWS_FILE)) fs.writeFileSync(WITHDRAWS_FILE, '[]');

// Helper to read/write JSON
function readJSON(file) { 
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // If file is empty or corrupted, return empty array
    console.error(`Error reading JSON file ${file}:`, e.message);
    return [];
  }
}

function writeJSON(file, data) { 
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error writing JSON file ${file}:`, e.message);
  }
}

// ----------------- Bot Setup -----------------
const bot = new TeleBot(BOT_TOKEN);

// ----------------- Helper Functions -----------------
function getUser(userId) {
  // Ensure userId is treated as a string for comparison
  const userIdStr = String(userId);
  const users = readJSON(USERS_FILE);
  return users.find(u => String(u.userId) === userIdStr);
}

function saveUser(user) {
  const users = readJSON(USERS_FILE);
  const index = users.findIndex(u => String(u.userId) === String(user.userId));
  if (index === -1) users.push(user);
  else users[index] = user;
  writeJSON(USERS_FILE, users);
}

function addPoints(userId, points) {
  let user = getUser(userId);
  if (!user) return;
  user.points += points;
  saveUser(user);
}

function getLevel(user) {
  return Math.floor(user.points / 500) + 1;
}

// ----------------- Web Server Fix (REQUIRED for Render Web Service Deployment) -----------------
// This code listens on a port so Render does not kill the process for 'Port scan timeout'.
const PORT = process.env.PORT || 8080; 

http.createServer((req, res) => {
    // Respond quickly to keep Render happy
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BinGo Telegram Bot is running in the background.');
}).listen(PORT, () => {
    console.log(`Web server running on port ${PORT} to keep Render alive.`);
});
// ----------------- End Web Server Fix -----------------------------------------------------

// ----------------- Bot Commands -----------------

bot.on(['/start'], (msg) => {
  const userId = String(msg.from.id);
  let user = getUser(userId);
  
  if (!user) {
    user = { userId, username: msg.from.username || 'Anonymous', points: 100 };
    saveUser(user);
    bot.sendMessage(userId, `🎉 Welcome to BinGo! You got 100 points.`);
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
  const users = readJSON(USERS_FILE).sort((a,b)=>b.points-a.points).slice(0,10);
  let text = "🏆 Top Players:\n";
  users.forEach((u,i) => text += `${i+1}. ${u.username} — ${u.points} pts\n`);
  bot.sendMessage(msg.from.id, text);
});

bot.on(['/withdraw'], (msg) => {
  const user = getUser(msg.from.id);
  if (!user) return bot.sendMessage(msg.from.id, "You are not registered yet. Use /start.");
  
  const parts = msg.text.split(" ");
  if (parts.length !== 2) {
    return bot.sendMessage(msg.from.id, `Usage: /withdraw <amount>. Minimum withdrawal is ${MIN_WITHDRAWAL} points.`);
  }

  const amount = parseInt(parts[1]);

  if (isNaN(amount) || amount <= 0) {
    return bot.sendMessage(msg.from.id, "Please enter a valid positive number for the amount.");
  }
  if (amount < MIN_WITHDRAWAL) {
    return bot.sendMessage(msg.from.id, `Minimum withdrawal amount is ${MIN_WITHDRAWAL} points.`);
  }
  if (user.points < amount) {
    return bot.sendMessage(msg.from.id, `You only have ${user.points} points. You need ${amount - user.points} more points.`);
  }

  // Deduct points immediately
  user.points -= amount;
  saveUser(user);

  const withdraws = readJSON(WITHDRAWS_FILE);
  const newRequest = { 
    id: Date.now().toString(), 
    userId: user.userId, 
    username: user.username, 
    amount: amount, // Include amount in the request
    status: "pending" 
  };
  withdraws.push(newRequest);
  writeJSON(WITHDRAWS_FILE, withdraws);

  bot.sendMessage(msg.from.id, `✅ Your withdraw request for ${amount} points has been sent! Your remaining points: ${user.points}.`);
  bot.sendMessage(ADMIN_ID, `💰 New Withdraw Request:\nUser: ${user.username}\nID: ${user.userId}\nAmount: ${amount} pts\nRequest ID: ${newRequest.id}`);
});

bot.on(['/referral'], (msg) => {
  // Use the BOT_USERNAME constant for robustness
  const refLink = `https://t.me/${BOT_USERNAME}?start=${msg.from.id}`;
  bot.sendMessage(msg.from.id, `Share this link to get referral bonus:\n${refLink}`);
});

// ----------------- Admin Commands -----------------
bot.on(['/addpoints'], (msg) => {
  // Compare IDs as numbers or strings, ensuring robustness
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  
  const parts = msg.text.split(" ");
  if (parts.length !== 3) return bot.sendMessage(msg.from.id, "Usage: /addpoints userId points");
  
  const targetUserId = parts[1];
  const points = parseInt(parts[2]);
  
  if (isNaN(points)) return bot.sendMessage(msg.from.id, "Points must be a number.");

  addPoints(targetUserId, points);
  bot.sendMessage(msg.from.id, `Added ${points} points to user ${targetUserId}`);
  
  // Optional: Notify the user who received the points
  bot.sendMessage(targetUserId, `🎁 You have received ${points} points from the Admin!`);
});

bot.on(['/completewithdraw'], (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const parts = msg.text.split(" ");
  if (parts.length !== 2) return bot.sendMessage(msg.from.id, "Usage: /completewithdraw withdrawId");

  const withdraws = readJSON(WITHDRAWS_FILE);
  const index = withdraws.findIndex(w => w.id === parts[1]);
  if (index === -1) return bot.sendMessage(msg.from.id, "Withdraw ID not found");
  
  const completedWithdraw = withdraws[index];

  // Mark status as completed
  withdraws[index].status = "completed";
  writeJSON(WITHDRAWS_FILE, withdraws);

  bot.sendMessage(msg.from.id, `Withdraw ID ${completedWithdraw.id} marked as completed for user ${completedWithdraw.username}.`);
  bot.sendMessage(completedWithdraw.userId, `✅ Your withdraw request for ${completedWithdraw.amount} points has been completed! Please check your account.`);
});

// ----------------- Start Bot -----------------
bot.start();
console.log("BinGo Bot is running on the hosting platform!");

