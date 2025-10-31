// ----------------- Dependencies -----------------
const fs = require('fs');
const TeleBot = require('telebot');
const http = require('http'); // Used to keep Render alive
const path = require('path'); // Used for dynamic pathing

// ----------------- Configuration (Securely Loaded) -----------------
// NOTE: BOT_TOKEN is loaded from the TELEGRAM_BOT_TOKEN environment variable on Render
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_ID = 7404076592; // Your personal Telegram ID (Judemonie)

// Determine the correct data storage path for the hosting environment
const DATA_FOLDER = process.env.TMPDIR ? path.join(process.env.TMPDIR, 'data') : './data';

// --- File Paths ---
const USERS_FILE = `${DATA_FOLDER}/users.json`;
const TASKS_COMPLETED_FILE = `${DATA_FOLDER}/tasks_completed.json`;
const WITHDRAWS_FILE = `${DATA_FOLDER}/withdraws.json`;
const TASKS_CONFIG_FILE = 'tasks_config.json'; // This file is read from the root repo

// ----------------- Initialization -----------------

// Ensure data folder exists in the writable directory (TMPDIR)
if (!fs.existsSync(DATA_FOLDER)) {
  fs.mkdirSync(DATA_FOLDER, { recursive: true });
}

// Initialize JSON files if they don't exist
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(TASKS_COMPLETED_FILE)) fs.writeFileSync(TASKS_COMPLETED_FILE, '[]');
if (!fs.existsSync(WITHDRAWS_FILE)) fs.writeFileSync(WITHDRAWS_FILE, '[]');

const MIN_WITHDRAWAL = 5000;

// Helper to read/write JSON
function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
    return [];
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error writing ${file}:`, e.message);
  }
}

function getTasksConfig() {
  try {
    // Read the static task configuration from the repo root
    return JSON.parse(fs.readFileSync(TASKS_CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error("Error reading tasks_config.json. Ensure file exists and is valid JSON.");
    return {};
  }
}

// ----------------- Bot Setup -----------------
const bot = new TeleBot(BOT_TOKEN);

// ----------------- Helper Functions -----------------
function getUser(userId) {
  const users = readJSON(USERS_FILE);
  // Use loose comparison (==) for robustness, as IDs can sometimes be strings or numbers
  return users.find(u => u.userId == userId.toString());
}

function saveUser(user) {
  const users = readJSON(USERS_FILE);
  const index = users.findIndex(u => u.userId == user.userId);
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

function hasCompletedTask(userId, taskName) {
  const completed = readJSON(TASKS_COMPLETED_FILE);
  return completed.some(c => c.userId == userId.toString() && c.taskName === taskName);
}

function markTaskCompleted(userId, taskName) {
  const completed = readJSON(TASKS_COMPLETED_FILE);
  if (!hasCompletedTask(userId, taskName)) {
    completed.push({ userId: userId.toString(), taskName, timestamp: Date.now() });
    writeJSON(TASKS_COMPLETED_FILE, completed);
    return true;
  }
  return false;
}

// --- Captcha and Wallet State Management ---
const captchaState = {}; // Stores { userId: { answer: 'X', attempts: Y } }
const walletPromptState = {}; // Stores { userId: true }

// --- Custom Keyboard ---
function getKeyboard() {
  return bot.keyboard([
    ['/tasks', '/points'],
    ['/myrefs', '/referral', '/withdraw ' + MIN_WITHDRAWAL] // Added /myrefs here
  ], { resize: true });
}

// ----------------- Bot Commands -----------------

// --- My Referrals ---
bot.on(['/myrefs'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);

  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.", { replyMarkup: getKeyboard() });
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });

  const allUsers = readJSON(USERS_FILE);
  const referredUsers = allUsers.filter(u => u.referrerId === userId);

  let text = `👥 **Your Referral Stats**\n\n`;

  if (referredUsers.length === 0) {
    text += "You have not referred anyone yet. Share your link to start earning!";
  } else {
    text += `Total Referred Users: **${referredUsers.length}**\n\n`;
    text += "Referred Users (last 10):\n";
    
    referredUsers.slice(0, 10).forEach((u, i) => {
      text += `${i + 1}. ${u.username} (ID: \`${u.userId.substring(0, 4)}...\`)\n`;
    });
    
    if (referredUsers.length > 10) {
        text += `\n... and ${referredUsers.length - 10} more.`;
    }
  }

  bot.sendMessage(userId, text, { parseMode: 'Markdown', replyMarkup: getKeyboard() });
});

// --- Wallet Management ---
bot.on(['/wallet'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);

  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.", { replyMarkup: getKeyboard() });
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });


  if (user.wallet) {
    bot.sendMessage(userId, `Your current BSC Wallet Address is:\n\`${user.wallet}\`\n\nSend your new address to update it.`, { parseMode: 'Markdown', replyMarkup: getKeyboard() });
  } else {
    walletPromptState[userId] = true;
    bot.sendMessage(userId, "Please send your **BSC Wallet Address** now to save it for withdrawals.", { parseMode: 'Markdown', replyMarkup: getKeyboard() });
  }
});

// --- Tasks ---
bot.on(['/tasks'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);

  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.", { replyMarkup: getKeyboard() });
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });


  let text = "📋 **Available Tasks**:\n\n";
  const tasksConfig = getTasksConfig();
  const tasks = tasksConfig.tasks || [];

  tasks.forEach(task => {
    const isCompleted = hasCompletedTask(userId, task.id);
    const status = isCompleted ? '✅' : '➡️';
    text += `${status} [${task.title} (+${task.points} pts)](${task.link})\n`;
  });

  text += "\nTo claim points, tap the button below.";

  const inlineKeyboard = tasks.filter(t => !hasCompletedTask(userId, t.id)).map(task => {
    return bot.inlineButton(`Claim ${task.title} (+${task.points} pts)`, { callback: `claim_${task.id}` });
  });

  if (inlineKeyboard.length === 0) {
    text += "\n\nAll tasks completed! Amazing work! 🎉";
  }

  bot.sendMessage(userId, text, {
    parseMode: 'Markdown',
    webPreview: false,
    replyMarkup: bot.inlineKeyboard([inlineKeyboard]),
    keyboard: getKeyboard()
  });
});

// --- Callback for Task Claims ---
bot.on('callbackQuery', async (msg) => {
  const userId = msg.from.id.toString();
  const data = msg.data;
  const user = getUser(userId);

  if (!user) return bot.answerCallbackQuery(msg.id, { text: "Please /start the bot first." });
  if (captchaState[userId]) return bot.answerCallbackQuery(msg.id, { text: "Please solve the anti-bot check first." });


  if (data.startsWith('claim_')) {
    const taskId = data.substring(6);
    const tasksConfig = getTasksConfig();
    const task = (tasksConfig.tasks || []).find(t => t.id === taskId);

    if (!task) return bot.answerCallbackQuery(msg.id, { text: "Task not found." });

    if (hasCompletedTask(userId, taskId)) {
      return bot.answerCallbackQuery(msg.id, { text: "You have already claimed this reward. ✅" });
    }

    if (taskId === 'join_tg_channel') {
      try {
        // Use Telegram's getChatMember API call
        const chatMember = await bot.getChatMember(task.username, userId);
        
        if (['member', 'administrator', 'creator'].includes(chatMember.status)) {
          // User is a member!
          markTaskCompleted(userId, taskId);
          addPoints(userId, task.points);
          bot.answerCallbackQuery(msg.id, { text: `✅ Task Complete! Added ${task.points} points!` });
          bot.sendMessage(userId, `🎉 You successfully completed the Telegram join task! You now have ${user.points + task.points} points.`, { replyMarkup: getKeyboard() });
        } else {
          bot.answerCallbackQuery(msg.id, { text: "❌ Please join the channel first to claim points." });
        }
      } catch (e) {
        console.error("Error checking TG membership:", e);
        bot.answerCallbackQuery(msg.id, { text: "❌ Could not verify membership. Make sure bot is Admin in the channel." });
      }
    } else if (taskId === 'follow_on_x') {
      // Honor System for external tasks
      markTaskCompleted(userId, taskId);
      addPoints(userId, task.points);
      bot.answerCallbackQuery(msg.id, { text: `✅ Thank you for following! Added ${task.points} points!` });
      bot.sendMessage(userId, `🎉 You completed the X follow task! You now have ${user.points + task.points} points. (We trust you!)`, { parseMode: 'Markdown', replyMarkup: getKeyboard() });
    } else if (taskId === 'setup_wallet') {
      // This button is mainly informational, the wallet is set via the /wallet command message handler
      bot.answerCallbackQuery(msg.id, { text: "Please use the /wallet command to set your address." });
    }
  }
});

// --- Points ---
bot.on(['/points'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);
  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.", { replyMarkup: getKeyboard() });
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });

  
  let walletStatus = user.wallet ? `\`${user.wallet.substring(0, 8)}...${user.wallet.substring(user.wallet.length - 4)}\`` : "❌ Not Set";
  
  bot.sendMessage(userId, `💰 **Your Stats**\nPoints: ${user.points}\nLevel: ${getLevel(user)}\nWallet: ${walletStatus}\n\nUse /tasks to earn more!`, { parseMode: 'Markdown', replyMarkup: getKeyboard() });
});

// --- Leaderboard ---
bot.on(['/leaderboard'], (msg) => {
  const userId = msg.from.id.toString();
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });

  
  const users = readJSON(USERS_FILE).sort((a, b) => b.points - a.points).slice(0, 10);
  let text = "🏆 **Top Players**:\n";
  users.forEach((u, i) => text += `${i + 1}. ${u.username} — ${u.points} pts\n`);
  bot.sendMessage(msg.from.id, text, { parseMode: 'Markdown', replyMarkup: getKeyboard() });
});

// --- Withdrawal ---
bot.on(['/withdraw'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);
  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.", { replyMarkup: getKeyboard() });
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });


  if (!user.wallet) return bot.sendMessage(userId, "❌ You must set your BSC Wallet Address first using the **/wallet** command.", { replyMarkup: getKeyboard() });

  const parts = msg.text.split(" ");
  if (parts.length !== 2 || isNaN(parseInt(parts[1]))) {
    return bot.sendMessage(userId, `Usage: /withdraw <amount>. Minimum withdrawal is ${MIN_WITHDRAWAL} points.`, { replyMarkup: getKeyboard() });
  }

  const amount = parseInt(parts[1]);

  if (amount < MIN_WITHDRAWAL) {
    return bot.sendMessage(userId, `❌ Minimum withdrawal amount is ${MIN_WITHDRAWAL} points.`, { replyMarkup: getKeyboard() });
  }
  if (user.points < amount) {
    return bot.sendMessage(userId, "❌ You do not have enough points for this withdrawal.", { replyMarkup: getKeyboard() });
  }

  // Deduct points immediately
  user.points -= amount;
  saveUser(user);

  const withdraws = readJSON(WITHDRAWS_FILE);
  const newRequest = {
    id: Date.now().toString(),
    userId: user.userId,
    username: user.username,
    wallet: user.wallet,
    amount: amount,
    status: "pending"
  };
  withdraws.push(newRequest);
  writeJSON(WITHDRAWS_FILE, withdraws);

  bot.sendMessage(userId, `✅ Your withdraw request for ${amount} points has been sent! Your new balance is ${user.points} pts.`, { replyMarkup: getKeyboard() });

  // Notify Admin
  bot.sendMessage(ADMIN_ID, `🚨 **NEW WITHDRAWAL REQUEST**\nUser: ${user.username} (${user.userId})\nAmount: ${amount} pts\nWallet: \`${user.wallet}\`\nRequest ID: \`${newRequest.id}\``, { parseMode: 'Markdown' });
});

// --- Referral ---
bot.on(['/referral'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);
  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.", { replyMarkup: getKeyboard() });
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.", { replyMarkup: getKeyboard() });

  
  const botUsername = msg.chat.username || 'BinGo_bsc_bot';
  // FIX: Use the correct bot username for the referral link
  const refLink = `https://t.me/${botUsername.replace('@', '')}?start=${userId}`;
  bot.sendMessage(userId, `👥 Share this link to earn a referral bonus when new users join:\n\n${refLink}`, { replyMarkup: getKeyboard() });
});

// ----------------- Captcha and Wallet Message Handler -----------------
bot.on('text', (msg) => {
  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  // 1. Handle Captcha Response
  if (captchaState[userId] && captchaState[userId].answer) {
    if (text === captchaState[userId].answer) {
      delete captchaState[userId];
      let user = getUser(userId);
      let isNewUser = !user;
      
      if (!user) { // Initialize user and assign referrer if they solve captcha
        const parts = msg.text.split(' ');
        const referrerId = parts.length > 1 && parts[1] !== userId ? parts[1] : null;
        
        user = { userId, username: msg.from.username || 'Anonymous', points: 100, wallet: null, referrerId: referrerId };
        saveUser(user);
      }
      
      bot.sendMessage(userId, `✅ Correct! Welcome to BinGo! You received 100 bonus points.`, { replyMarkup: getKeyboard() });
      
      // Award referrer bonus (Referral ID is saved in startNewUser but awarded here after captcha)
      if (isNewUser && user.referrerId) {
          let referrer = getUser(user.referrerId);
          if (referrer) {
              addPoints(user.referrerId, 25); // Referral bonus
              bot.sendMessage(user.referrerId, `🎁 You received a 25 point bonus because ${user.username} started the bot!`);
          }
      }
      return;
    } else {
      captchaState[userId].attempts++;
      if (captchaState[userId].attempts >= 3) {
        delete captchaState[userId];
        return bot.sendMessage(userId, "❌ Too many failed attempts. Please restart the bot with /start.");
      }
      const attemptsLeft = 3 - captchaState[userId].attempts;
      return bot.sendMessage(userId, `❌ Incorrect answer. Try again. (${attemptsLeft} attempts left).`);
    }
  }

  // 2. Handle Wallet Update Response
  if (walletPromptState[userId] && text.length >= 20 && text.startsWith('0x')) {
    delete walletPromptState[userId];
    const user = getUser(userId);
    user.wallet = text;
    saveUser(user);
    bot.sendMessage(userId, `✅ Your new BSC Wallet Address has been saved:\n\`${user.wallet}\``, { parseMode: 'Markdown', replyMarkup: getKeyboard() });
    return;
  } else if (walletPromptState[userId]) {
    return bot.sendMessage(userId, "❌ That doesn't look like a valid BSC address (must start with 0x and be long enough). Please try again.");
  }
});

// ----------------- Startup Logic -----------------

function startNewUser(msg) {
  const userId = msg.from.id.toString();
  const parts = msg.text.split(' ');
  const referrerId = parts.length > 1 ? parts[1] : null;

  // 1. Captcha Generation
  const num1 = Math.floor(Math.random() * 9) + 1;
  const num2 = Math.floor(Math.random() * 9) + 1;
  const answer = (num1 + num2).toString();

  captchaState[userId] = { answer, attempts: 0 };

  bot.sendMessage(userId, `🤖 **Anti-Bot Check**\nTo start, please solve this simple math problem:\n\nWhat is ${num1} + ${num2}?`);

  // 2. Save referrer ID immediately for later use after captcha is solved
  if (referrerId && referrerId !== userId) {
    let users = readJSON(USERS_FILE);
    let tempUser = { userId, username: msg.from.username || 'Anonymous', points: 0, wallet: null, referrerId: referrerId };
    users.push(tempUser);
    writeJSON(USERS_FILE, users);
    console.log(`Temp user ${userId} created with referrer ${referrerId}`);
  }
}

bot.on(['/start'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);

  if (user && !user.points) {
      // User exists temporarily from a failed captcha—start captcha flow again
      startNewUser(msg);
  } else if (user) {
    // Existing user
    bot.sendMessage(userId, `Welcome back, ${user.username}! You have ${user.points} points. Level: ${getLevel(user)}`, { replyMarkup: getKeyboard() });
  } else {
    // New user - Start Captcha Flow
    startNewUser(msg);
  }
});

// ----------------- Admin Commands -----------------

// --- Add Points ---
bot.on(['/addpoints'], (msg) => {
  const userId = msg.from.id.toString();
  if (userId != ADMIN_ID) return;

  const parts = msg.text.split(" ");
  if (parts.length !== 3 || isNaN(parseInt(parts[2]))) {
    return bot.sendMessage(userId, "Usage: /addpoints <userId> <points>");
  }

  const targetId = parts[1];
  const points = parseInt(parts[2]);

  let targetUser = getUser(targetId);
  if (!targetUser) return bot.sendMessage(userId, `User ${targetId} not found.`);

  addPoints(targetId, points);

  bot.sendMessage(userId, `✅ Added ${points} points to user ${targetId}. New balance: ${targetUser.points + points}`);
  bot.sendMessage(targetId, `✨ The Admin added ${points} points to your account!`);
});

// --- Complete Withdrawal ---
bot.on(['/completewithdraw'], (msg) => {
  const userId = msg.from.id.toString();
  if (userId != ADMIN_ID) return;

  const parts = msg.text.split(" ");
  if (parts.length !== 2) return bot.sendMessage(userId, "Usage: /completewithdraw <withdrawId>");

  const withdrawId = parts[1];
  const withdraws = readJSON(WITHDRAWS_FILE);
  const index = withdraws.findIndex(w => w.id === withdrawId);

  if (index === -1) return bot.sendMessage(userId, "Withdraw ID not found");

  const request = withdraws[index];
  request.status = "completed";
  writeJSON(WITHDRAWS_FILE, withdraws);

  bot.sendMessage(userId, `✅ Withdraw ID ${withdrawId} marked as completed.`);
  bot.sendMessage(request.userId, `✅ Your withdrawal request for ${request.amount} points to wallet \`${request.wallet}\` has been **COMPLETED!**`, { parseMode: 'Markdown' });
});

// --- Broadcast Message ---
bot.on(['/broadcast'], (msg) => {
  const userId = msg.from.id.toString();
  if (userId != ADMIN_ID) return;

  // Message format: /broadcast Your message here
  const broadcastMessage = msg.text.substring('/broadcast'.length).trim();

  if (!broadcastMessage) {
    return bot.sendMessage(userId, "Usage: /broadcast <Your message here>");
  }

  const users = readJSON(USERS_FILE);
  let count = 0;
  users.forEach(user => {
    try {
      bot.sendMessage(user.userId, `📢 **ADMIN BROADCAST**\n\n${broadcastMessage}`, { parseMode: 'Markdown' });
      count++;
    } catch (e) {
      console.log(`Failed to send broadcast to user ${user.userId}`);
    }
  });

  bot.sendMessage(ADMIN_ID, `✅ Broadcast sent to ${count} active users.`);
});

// ----------------- Start Bot and Web Server -----------------

// Start the Telegram Polling Bot
bot.start();
console.log("BinGo Bot is running on the hosting platform!");

// Start a simple web server to satisfy Render's 'Web Service' requirement
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BinGo Telegram Bot is running in the background.');
}).listen(PORT, () => {
  console.log(`Web server running on port ${PORT} to keep Render alive.`);
});

