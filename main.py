# ... existing imports ...
from telegram import Update, ForceReply
from telegram.ext import ConversationHandler, filters
# ... other imports ...

# Define States for the Wallet Conversation (Existing)
GET_WALLET = 1 
# Define States for the Withdrawal Conversation (Existing)
GET_WITHDRAW_AMOUNT = 2
CONFIRM_WITHDRAWAL = 3 
# Define States for the Task Submission Conversation (NEW)
SUBMIT_TWITTER = 4

# --- Task Command Handlers ---

async def tasks_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Displays the list of tasks and initiates the submission process."""
    user_id = update.effective_user.id
    user_data = users_collection.find_one({"_id": user_id})

    if not user_data:
        await update.message.reply_text("Please use the /start command first to register.")
        return ConversationHandler.END

    # Check if wallet is set
    wallet_status = "✅ Set" if user_data.get("wallet_address") else "❌ Not Set (Use /wallet)"
    
    # Define tasks and check status
    task_status = user_data.get("tasks", {})
    twitter_status = "✅ Completed" if task_status.get("twitter_follow") else "❌ Submit Proof (Send your X profile link)"
    tg_status = "✅ Completed" if task_status.get("tg_join") else "❌ Join Group (Not checked yet)"

    message = (
        "📜 **Airdrop Tasks & Status**\n"
        "Complete these tasks to earn up to **500 Points**.\n"
        "-------------------------------------\n"
        f"1. **Wallet:** {wallet_status}\n"
        f"2. **Follow X:** {twitter_status}\n"
        f"   🔗 [Follow Jude BNB on X](https://x.com/jude_bnb)\n"
        f"3. **Join Telegram:** {tg_status}\n"
        f"   🔗 [Join Token Screener Group](https://t.me/tokenscreene)\n"
        "-------------------------------------\n\n"
        "To submit proof for **Task 2 (Follow X)**, please send the **URL of your X profile** (e.g., `https://x.com/yourusername`) now. "
        "Your points will be credited after manual admin review."
    )
    
    await update.message.reply_text(message, parse_mode='Markdown', disable_web_page_preview=True)
    return SUBMIT_TWITTER


async def receive_twitter_proof(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Receives the user's X profile link for manual verification."""
    user_id = update.effective_user.id
    user_name = update.effective_user.username or "N/A"
    proof_link = update.message.text.strip()
    
    # Basic validation for an X/Twitter link format
    if not proof_link.startswith(("https://x.com/", "https://twitter.com/")):
        await update.message.reply_text(
            "⚠️ Invalid format. Please submit the full URL of your X profile, starting with `https://x.com/`."
        )
        return SUBMIT_TWITTER # Stay in this state

    # Update MongoDB with proof for admin check
    users_collection.find_one_and_update(
        {"_id": user_id},
        {"$set": {"tasks.twitter_proof": proof_link, "tasks.twitter_status": "PENDING_REVIEW"}}
    )
    
    await update.message.reply_text(
        "📝 **Proof Submitted!** Your X follow proof has been recorded and will be reviewed by the admin.\n"
        "Points will be credited shortly. Use /tasks to check status."
    )
    
    # Notify Admin of new proof submission
    admin_message = (
        "🚨 **NEW TASK PROOF SUBMISSION** 🚨\n\n"
        f"**User ID:** `{user_id}`\n"
        f"**Username:** @{user_name}\n"
        f"**Task:** Follow X\n"
        f"**Proof Link:** {proof_link}\n\n"
        f"**Action:** Verify follow on X and use the /reward command if successful."
    )
    await context.bot.send_message(chat_id=ADMIN_ID, text=admin_message, parse_mode='Markdown')

    return ConversationHandler.END
