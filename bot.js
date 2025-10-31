// ----------------- Dependencies -----------------
const fs = require('fs');
const TeleBot = require('telebot');
const http = require('http'); 
const path = require('path'); 

// ----------------- Configuration (Securely Loaded) -----------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_ID = 7404076592; // Your personal Telegram ID (Judemonie)
const BOT_USERNAME_FIXED = 'BinGo_bsc_bot'; 

// Determine the correct data storage path for the hosting environment
const DATA_FOLDER = process.env.TMPDIR ? path.join(process.env.TMPDIR, 'data') : './data';

// --- File Paths ---
const USERS_FILE = path.join(DATA_FOLDER, 'users.json'); 
const TASKS_COMPLETED_FILE = path.join(DATA_FOLDER, 'tasks_completed.json');
const WITHDRAWS_FILE = path.join(DATA_FOLDER, 'withdraws.json');
const MANUAL_VERIFICATION_FILE = path.join(DATA_FOLDER, 'manual_verification.json'); 
const TASKS_CONFIG_FILE = 'tasks_config.json'; 

// ----------------- Initialization -----------------
if (!fs.existsSync(DATA_FOLDER)) {
  fs.mkdirSync(DATA_FOLDER, { recursive: true });
}

// Initialize JSON files if they don't exist
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(TASKS_COMPLETED_FILE)) fs.writeFileSync(TASKS_COMPLETED_FILE, '[]');
if (!fs.existsSync(WITHDRAWS_FILE)) fs.writeFileSync(WITHDRAWS_FILE, '[]');
if (!fs.existsSync(MANUAL_VERIFICATION_FILE)) fs.writeFileSync(MANUAL_VERIFICATION_FILE, '{}'); 

const MIN_WITHDRAWAL = 5000;

// Helper to read/write JSON
function readJSON(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (!data.trim()) {
        return (file === USERS_FILE || file === TASKS_COMPLETED_FILE || file === WITHDRAWS_FILE) ? [] : {};
    }
    return JSON.parse(data);
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
    return (file === USERS_FILE || file === TASKS_COMPLETED_FILE || file === WITHDRAWS_FILE) ? [] : {};
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
    return JSON.parse(fs.readFileSync(TASKS_CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error("Error reading tasks_config.json. Ensure file exists and is valid JSON.");
    return {};
  }
}

// ----------------- Bot Setup -----------------
// FIX: Removed polling options to resolve 409 Conflict error
const bot = new TeleBot(BOT_TOKEN); 

// ----------------- Helper Functions -----------------
function getUser(userId) {
  const users = readJSON(USERS_FILE);
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
const captchaState = {}; 
const walletPromptState = {}; 
const manualCheckState = {}; 

// --- Custom Keyboard: NOW INLINE ---
function getMainMenuInlineKeyboard() {
  return bot.inlineKeyboard([
    [
      bot.inlineButton('📋 View Tasks', { callback: 'show_tasks' }),
      bot.inlineButton('💰 My Points', { callback: 'show_points' })
    ],
    [
      bot.inlineButton('💳 Set Wallet', { callback: 'set_wallet' }),
      bot.inlineButton('🔗 My Referral Link', { callback: 'show_referral' })
    ],
    [
      bot.inlineButton('💸 Withdraw', { callback: 'prompt_withdraw' })
    ]
  ]);
}

// --- Withdrawal Keyboard ---
function getWithdrawalKeyboard() {
  return bot.inlineKeyboard([
    [
      bot.inlineButton('5,000 pts', { callback: 'withdraw_5000' }),
      bot.inlineButton('10,000 pts', { callback: 'withdraw_10000' })
    ],
    [
      bot.inlineButton('20,000 pts', { callback: 'withdraw_20000' }),
      bot.inlineButton('⬅️ Cancel', { callback: 'main_menu' })
    ]
  ]);
}


// ----------------- Bot Commands (Main Logic) -----------------

// --- Menu/Start Commands ---
bot.on(['/menu', '/start'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);

  if (!user || user.points <= 0) {
      if (msg.text.startsWith('/start') && !captchaState[userId]) {
         return startNewUser(msg);
      }
      if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.");
  }
  
  bot.sendMessage(userId, "🚀 **BinGo Main Menu**\n\nChoose an action below:", {
      parseMode: 'Markdown',
      replyMarkup: getMainMenuInlineKeyboard()
  });
});

// --- Wallet Management ---
bot.on(['/wallet'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);

  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.");
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.");

  walletPromptState[userId] = true;
  if (user.wallet) {
    bot.sendMessage(userId, `Your current BSC Wallet Address is:\n\`${user.wallet}\`\n\nPlease send your **new** address now to update it.`, { parseMode: 'Markdown' });
  } else {
    bot.sendMessage(userId, "Please send your **BSC Wallet Address** now to save it for withdrawals.", { parseMode: 'Markdown' });
  }
});

// --- Withdrawal (Initial Command) ---
bot.on(['/withdraw'], (msg) => {
  const userId = msg.from.id.toString();
  const user = getUser(userId);
  if (!user) return bot.sendMessage(userId, "You are not registered yet. Use /start.");
  if (captchaState[userId]) return bot.sendMessage(userId, "Please solve the anti-bot check first.");

  if (!user.wallet) return bot.sendMessage(userId, "❌ You must set your BSC Wallet Address first using the **/wallet** command.");

  bot.sendMessage(userId, `💸 **Withdrawal Request**\n\nYour current balance: **${user.points}** pts\nMinimum withdrawal: **${MIN_WITHDRAWAL}** pts\n\nSelect the amount you wish to withdraw:`, { 
      parseMode: 'Markdown',
      replyMarkup: getWithdrawalKeyboard() 
  });
});


// --- General Callback Query Handler ---
bot.on('callbackQuery', async (msg) => {
  const userId = msg.from.id.toString();
  const data = msg.data;
  const user = getUser(userId);

  if (!user) return bot.answerCallbackQuery(msg.id, { text: "Please /start the bot first." });
  if (captchaState[userId]) return bot.answerCallbackQuery(msg.id, { text: "Please solve the anti-bot check first." });

  const currentMessageId = msg.message.message_id;

  if (data === 'main_menu') {
      bot.editMessageText(
          { chatId: userId, messageId: currentMessageId },
          "🚀 **BinGo Main Menu**\n\nChoose an action below:",
          { parseMode: 'Markdown', replyMarkup: getMainMenuInlineKeyboard() }
      );
      bot.answerCallbackQuery(msg.id);
  } 
  
  // --- SHOW TASKS ---
  else if (data === 'show_tasks') {
      const tasksConfig = getTasksConfig();
      const tasks = tasksConfig.tasks || [];

      let text = "📋 **Available Tasks**:\n\n";
      tasks.forEach(task => {
        const isCompleted = hasCompletedTask(userId, task.id);
        const status = isCompleted ? '✅' : '➡️';
        text += `${status} [${task.title} (+${task.points} pts)](${task.link})\n`;
      });
      text += "\nTap a button below to check and claim points.";

      const manualChecks = readJSON(MANUAL_VERIFICATION_FILE);
      const isUnderReview = (taskId) => {
          const check = manualChecks[userId] && manualChecks[userId].find(r => r.taskId === taskId);
          return check && check.status === 'pending';
      }
      
      const inlineKeyboard = tasks.filter(t => !hasCompletedTask(userId, t.id)).map(task => {
          if(isUnderReview(task.id)) {
              return bot.inlineButton(`⏳ ${task.title} (Under Review)`, { callback: 'noop' });
          }
          return bot.inlineButton(`Claim ${task.title} (+${task.points} pts)`, { callback: `claim_${task.id}` });
      });

      let finalKeyboard = [];
      if (inlineKeyboard.length > 0) {
        for (let i = 0; i < inlineKeyboard.length; i += 2) {
            finalKeyboard.push(inlineKeyboard.slice(i, i + 2));
        }
      } else {
        text += "\n\nAll tasks completed! Amazing work! 🎉";
      }

      finalKeyboard.push([bot.inlineButton('⬅️ Back to Menu', { callback: 'main_menu' })]);
      
      bot.editMessageText(
        { chatId: userId, messageId: currentMessageId }, 
        text, 
        { parseMode: 'Markdown', webPreview: false, replyMarkup: bot.inlineKeyboard(finalKeyboard) }
      );
      bot.answerCallbackQuery(msg.id);
      
  } 
  
  // --- WITHDRAWAL & REFERRAL & POINTS LOGIC ---
  else if (data === 'show_points') {
      let walletStatus = user.wallet ? `\`${user.wallet.substring(0, 8)}...${user.wallet.substring(user.wallet.length - 4)}\`` : "❌ Not Set";
      bot.editMessageText({ chatId: userId, messageId: currentMessageId }, `💰 **Your Stats**\nPoints: ${user.points}\nLevel: ${getLevel(user)}\nWallet: ${walletStatus}\n\nUse /menu to see options!`, { parseMode: 'Markdown', replyMarkup: getMainMenuInlineKeyboard() });
      bot.answerCallbackQuery(msg.id);
  } else if (data === 'show_referral') {
      const botUsername = BOT_USERNAME_FIXED;
      const refLink = `https://t.me/${botUsername.replace('@', '')}?start=${userId}`;
      bot.editMessageText({ chatId: userId, messageId: currentMessageId }, `👥 **Your Referral Link:**\n\nShare this link to earn a bonus when new users join:\n\n\`${refLink}\``, { parseMode: 'Markdown', replyMarkup: getMainMenuInlineKeyboard() });
      bot.answerCallbackQuery(msg.id);
  } else if (data === 'set_wallet') {
      walletPromptState[userId] = true;
      bot.sendMessage(userId, "Please send your **BSC Wallet Address** now to save it for withdrawals. (Must start with 0x)", { parseMode: 'Markdown' });
      bot.answerCallbackQuery(msg.id, { text: "Please send the address now." });
  } else if (data === 'prompt_withdraw') {
      if (!user.wallet) {
          bot.answerCallbackQuery(msg.id, { text: "❌ Set your wallet first using /wallet or the Set Wallet button." });
          return;
      }
      bot.editMessageText({ chatId: userId, messageId: currentMessageId }, `💸 **Withdrawal Request**\n\nYour current balance: **${user.points}** pts\nMinimum withdrawal: **${MIN_WITHDRAWAL}** pts\n\nSelect the amount you wish to withdraw:`, { parseMode: 'Markdown', replyMarkup: getWithdrawalKeyboard() });
      bot.answerCallbackQuery(msg.id);
  } else if (data.startsWith('withdraw_')) {
      const amount = parseInt(data.substring(9)); 
      if (amount < MIN_WITHDRAWAL) return bot.answerCallbackQuery(msg.id, { text: `❌ Minimum withdrawal amount is ${MIN_WITHDRAWAL} points.` });
      if (user.points < amount) return bot.answerCallbackQuery(msg.id, { text: "❌ You do not have enough points for this withdrawal." });

      user.points -= amount;
      saveUser(user);

      const withdraws = readJSON(WITHDRAWS_FILE);
      const newRequest = { id: Date.now().toString(), userId: user.userId, username: user.username, wallet: user.wallet, amount: amount, status: "pending" };
      withdraws.push(newRequest);
      writeJSON(WITHDRAWS_FILE, withdraws);
      
      bot.editMessageText({ chatId: userId, messageId: currentMessageId }, `✅ Your withdraw request for ${amount} points has been sent! Your new balance is ${user.points} pts.`, { parseMode: 'Markdown', replyMarkup: getMainMenuInlineKeyboard() });
      bot.answerCallbackQuery(msg.id, { text: "Request sent successfully!" });
      bot.sendMessage(ADMIN_ID, `🚨 **NEW WITHDRAWAL REQUEST**\nUser: ${user.username} (${user.userId})\nAmount: ${amount} pts\nWallet: \`${user.wallet}\`\nRequest ID: \`${newRequest.id}\``, { parseMode: 'Markdown' });
  } 
  
  // --- CLAIM TASK LOGIC (MODIFIED) ---
  else if (data.startsWith('claim_')) {
    const taskId = data.substring(6);
    const tasksConfig = getTasksConfig();
    const task = (tasksConfig.tasks || []).find(t => t.id === taskId);

    if (!task) return bot.answerCallbackQuery(msg.id, { text: "Task not found." });
    if (hasCompletedTask(userId, taskId)) return bot.answerCallbackQuery(msg.id, { text: "You have already claimed this reward. ✅" });

    // 1. Channel Join (Automatic Verification)
    if (task.type === 'channel') {
      try {
        const chatMember = await bot.getChatMember(task.username, userId);
        
        if (['member', 'administrator', 'creator'].includes(chatMember.status)) {
          markTaskCompleted(userId, taskId);
          addPoints(userId, task.points);
          bot.answerCallbackQuery(msg.id, { text: `✅ Task Complete! Added ${task.points} points!` });
          bot.sendMessage(userId, `🎉 You successfully completed the Telegram join task! You now have ${user.points + task.points} points.`, { replyMarkup: getMainMenuInlineKeyboard() });
        } else {
          bot.answerCallbackQuery(msg.id, { text: "❌ Please join the channel first to claim points." });
        }
      } catch (e) {
        bot.answerCallbackQuery(msg.id, { text: "❌ Could not verify. Make sure bot is Admin in the channel." });
      }
    } 
    
    // 2. Social Media (Manual Verification)
    else if (task.type === 'social') {
        const manualChecks = readJSON(MANUAL_VERIFICATION_FILE);
        
        if (manualChecks[userId] && manualChecks[userId].some(r => r.taskId === taskId && r.status === 'pending')) {
            return bot.answerCallbackQuery(msg.id, { text: "⏳ Your submission for this task is already under review." });
        }

        manualCheckState[userId] = { taskId: taskId, status: 'awaiting_username' };
        
        bot.sendMessage(userId, 
          `🔗 **Task: ${task.title}**\n\nTo complete this task, please **reply to this message** with your X (Twitter) \`@username\` (e.g., \`@Judemonie\`)\n\n*The Admin will review your account and approve the points manually.*`, 
          { parseMode: 'Markdown', replyMarkup: bot.forceReply() }
        );
        
        bot.answerCallbackQuery(msg.id, { text: `Please submit your X username.` });
    }
  } else if (data === 'noop') {
      bot.answerCallbackQuery(msg.id, { text: 'Your claim is pending admin review. Thank you for your patience.' });
  }
});


// ----------------- Captcha, Wallet, and Manual Check Handler -----------------
bot.on('text', (msg) => {
  const userId = msg.from.id.toString();
  const text = msg.text.trim();
  const user = getUser(userId);

  // --- ADMIN COMMANDS ---
  if (userId == ADMIN_ID) {
      if (text.startsWith('/approve')) {
          const parts = text.split(" ");
          if (parts.length !== 3) return bot.sendMessage(userId, "Usage: /approve <targetUserId> <taskId>");
          const targetId = parts[1];
          const taskId = parts[2];
          
          const targetUser = getUser(targetId);
          const tasksConfig = getTasksConfig();
          const task = (tasksConfig.tasks || []).find(t => t.id === taskId);
          
          if (!targetUser) return bot.sendMessage(userId, "Target user not found.");
          if (!task) return bot.sendMessage(userId, "Task ID not found.");
          if (hasCompletedTask(targetId, taskId)) return bot.sendMessage(userId, "Task already completed.");

          markTaskCompleted(targetId, taskId);
          addPoints(targetId, task.points);
          
          // Remove from verification list
          let verifications = readJSON(MANUAL_VERIFICATION_FILE);
          if (verifications[targetId]) {
              verifications[targetId] = verifications[targetId].filter(r => r.taskId !== taskId);
              if (verifications[targetId].length === 0) delete verifications[targetId];
              writeJSON(MANUAL_VERIFICATION_FILE, verifications);
          }

          bot.sendMessage(userId, `✅ **APPROVED!** ${task.points} points added to user ${targetId}.`);
          bot.sendMessage(targetId, `🎉 **Admin Approval!** Your submission for **${task.title}** has been approved. You received ${task.points} points!`);
          return;
      }
      
      if (text.startsWith('/reject')) {
          const parts = text.split(" ");
          if (parts.length !== 3) return bot.sendMessage(userId, "Usage: /reject <targetUserId> <taskId>");
          const targetId = parts[1];
          const taskId = parts[2];
          
          let verifications = readJSON(MANUAL_VERIFICATION_FILE);
          if (verifications[targetId]) {
              verifications[targetId] = verifications[targetId].filter(r => r.taskId !== taskId);
              if (verifications[targetId].length === 0) delete verifications[targetId];
              writeJSON(MANUAL_VERIFICATION_FILE, verifications);
          }
          
          const targetUser = getUser(targetId);
          const tasksConfig = getTasksConfig();
          const task = (tasksConfig.tasks || []).find(t => t.id === taskId);

          bot.sendMessage(userId, `❌ **REJECTED!** User ${targetId} notified.`);
          bot.sendMessage(targetId, `❌ **Admin Review:** Your submission for **${task.title}** was denied. Please ensure you completed the task and submit again.`, { parseMode: 'Markdown' });
          return;
      }
      
      if (text.startsWith('/addpoints')) {
        const parts = text.split(" ");
        if (parts.length !== 3 || isNaN(parseInt(parts[2]))) {
          return bot.sendMessage(userId, "Usage: /addpoints <userId> <points>");
        }

        const targetId = parts[1];
        const points = parseInt(parts[2]);

        let targetUser = getUser(targetId);
        if (!targetUser) return bot.sendMessage(userId, `User ${targetId} not found.`);

        addPoints(targetId, points);

        bot.sendMessage(userId, `✅ Added ${points} points to user ${targetId}. New balance: ${targetUser.points}`);
        bot.sendMessage(targetId, `✨ The Admin added ${points} points to your account!`);
        return;
      }

      if (text.startsWith('/completewithdraw')) {
        const parts = text.split(" ");
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
        return;
      }

      if (text.startsWith('/broadcast')) {
        const broadcastMessage = text.substring('/broadcast'.length).trim();

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
        return;
      }
  }

  // --- 1. HANDLE MANUAL X/TWITTER SUBMISSION ---
  if (user && manualCheckState[userId] && manualCheckState[userId].status === 'awaiting_username' && msg.reply_to_message && msg.reply_to_message.text.includes('reply to this message with your X (Twitter)')) {
      const taskId = manualCheckState[userId].taskId;
      const tasksConfig = getTasksConfig();
      const task = (tasksConfig.tasks || []).find(t => t.id === taskId);
      
      delete manualCheckState[userId];
      
      const xUsername = text.startsWith('@') ? text : `@${text}`;
      
      // Save verification request to the file
      let verifications = readJSON(MANUAL_VERIFICATION_FILE);
      if (!verifications[userId]) verifications[userId] = [];
      
      verifications[userId].push({
          taskId: taskId,
          username: xUsername,
          timestamp: Date.now(),
          status: 'pending'
      });
      writeJSON(MANUAL_VERIFICATION_FILE, verifications);
      
      bot.sendMessage(userId, `⏳ **Submitted!** Your X account (\`${xUsername}\`) has been sent for review for the **${task.title}** task. The Admin will check and approve your points shortly!`, { parseMode: 'Markdown' });
      
      // Notify Admin
      bot.sendMessage(ADMIN_ID, 
        `🔔 **NEW TASK SUBMISSION**
        \nUser: ${user.username || 'Anonymous'} (\`${userId}\`)
        \nTask: **${task.title}**
        \nX User: \`${xUsername}\`
        \n\nTo approve: \`/approve ${userId} ${taskId}\`
        \nTo reject: \`/reject ${userId} ${taskId}\``, 
        { parseMode: 'Markdown' }
      );
      return;
  }
  
  // --- 2. CAPTCHA Handling ---
  if (user && captchaState[userId] && captchaState[userId].answer && msg.reply_to_message && msg.reply_to_message.text.includes('solve this simple math problem')) {
      const expectedAnswer = captchaState[userId].answer;
      
      if (text === expectedAnswer) {
          delete captchaState[userId];
          let isNewUser = !user || user.points === 0;
          
          if (isNewUser) { 
            const parts = msg.text.split(' ');
            const referrerId = parts.length > 1 && parts[1] !== userId ? parts[1] : null;
            
            let newUser = { userId, username: msg.from.username || 'Anonymous', points: 100, wallet: null, referrerId: referrerId };
            saveUser(newUser);

            if (referrerId) {
                let referrer = getUser(referrerId);
                if (referrer) {
                    addPoints(referrerId, 25); 
                    bot.sendMessage(referrerId, `🎁 You received a 25 point bonus because ${newUser.username} started the bot!`);
                }
            }
          }
          
          bot.sendMessage(userId, `✅ Correct! Welcome to BinGo! You received 100 bonus points.`, { replyMarkup: getMainMenuInlineKeyboard() });
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

  // --- 3. Wallet Update Response ---
  if (walletPromptState[userId]) {
    if (text.length >= 20 && text.startsWith('0x')) {
        delete walletPromptState[userId];
        const user = getUser(userId);
        user.wallet = text;
        saveUser(user);
        bot.sendMessage(userId, `✅ Your new BSC Wallet Address has been saved:\n\`${user.wallet}\``, { parseMode: 'Markdown' });
        return;
    } else {
        return bot.sendMessage(userId, "❌ That doesn't look like a valid BSC address (must start with 0x and be long enough). Please try again.");
    }
  }
  
  // 4. Default Message
  if (text.startsWith('/') && userId != ADMIN_ID) {
      if (user) {
          bot.sendMessage(userId, "I don't recognize that command. Try /menu to see your options.", { replyMarkup: getMainMenuInlineKeyboard() });
      }
  }
});


// ----------------- Startup Logic -----------------
function startNewUser(msg) {
  const userId = msg.from.id.toString();
  const parts = msg.text.split(' ');
  const referrerId = parts.length > 1 ? parts[1] : null;

  const num1 = Math.floor(Math.random() * 9) + 1;
  const num2 = Math.floor(Math.random() * 9) + 1;
  const answer = (num1 + num2).toString();

  captchaState[userId] = { answer, attempts: 0 };

  bot.sendMessage(userId, `🤖 **Anti-Bot Check**\nTo start, please solve this simple math problem:\n\nWhat is ${num1} + ${num2}?`);

  if (referrerId && referrerId !== userId) {
    let users = readJSON(USERS_FILE);
    let existingIndex = users.findIndex(u => u.userId == userId);

    if (existingIndex === -1) {
        let tempUser = { userId, username: msg.from.username || 'Anonymous', points: 0, wallet: null, referrerId: referrerId };
        users.push(tempUser);
        writeJSON(USERS_FILE, users);
    }
  }
}

// ----------------- Start Bot and Web Server -----------------
bot.start();
console.log("BinGo Bot is running on the hosting platform!");

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BinGo Telegram Bot is running in the background.');
}).listen(PORT, () => {
  console.log(`Web server running on port ${PORT} to keep Render alive.`);
});
