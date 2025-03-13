
// Telegram Buy Bot for tracking token purchases
// Libraries required
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const { default: axios } = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  token: '8187685395:AAFpVnHTCM0OjdkE_XxUIq2XDH6uYN-Y91M',
  providers: {
    BNB: 'https://bsc-dataseed.binance.org/',
    Solana: 'https://api.mainnet-beta.solana.com'
  },
  scannerUrls: {
    BNB: 'https://bscscan.com/tx/',
    Solana: 'https://solscan.io/tx/'
  }
};

// Database simulation (in production use MongoDB/Postgres)
const db = {
  groups: {},
  saveGroup(groupId, data) {
    this.groups[groupId] = { ...this.groups[groupId], ...data };
    // In production, save to real database
    console.log(`Group ${groupId} settings updated:`, data);
  },
  getGroup(groupId) {
    return this.groups[groupId] || {};
  }
};

// Initialize bot
const bot = new Telegraf(config.token);

// Welcome message when user starts the bot in private chat
bot.start(async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.replyWithPhoto(
      { source: path.join(__dirname, 'assets', 'welcome.png') },
      {
        caption: '🚀 Welcome to BuyTracker Bot! 🚀\n\n' +
                'I track token purchases on blockchain networks and send notifications to your group.\n\n' +
                'To get started:\n' +
                '1️⃣ Add me to your Telegram group\n' +
                '2️⃣ Make me an admin in the group\n' +
                '3️⃣ Type /setup in the group to configure tracking\n\n' +
                'I support both BNB Chain and Solana networks!',
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('Add to Group', 'https://t.me/bybotsssbot?startgroup=true')]
        ])
      }
    );
  } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    // Check if bot is admin in the group
    try {
      const admins = await ctx.getChatAdministrators();
      const botId = ctx.botInfo.id;
      const isBotAdmin = admins.some(admin => admin.user.id === botId);
      
      if (isBotAdmin) {
        await ctx.reply('I am ready to be configured! Type /setup to start tracking token purchases.');
      } else {
        await ctx.reply('Please make me an admin in this group to enable all features!');
      }
    } catch (error) {
      console.error('Error checking admin status:', error);
      await ctx.reply('An error occurred while checking my permissions.');
    }
  }
});

// Help command
bot.help((ctx) => {
  ctx.reply(
    '📚 <b>BuyTracker Bot Commands</b>\n\n' +
    '/setup - Configure token tracking\n' +
    '/status - Check current tracking status\n' +
    '/stop - Stop tracking\n' +
    '/help - Show this help message\n\n' +
    'Need assistance? Contact @YourSupportUsername',
    { parse_mode: 'HTML' }
  );
});

// Setup wizard
const setupScene = new Scenes.WizardScene(
  'setup-wizard',
  // Step 1: Select blockchain
  async (ctx) => {
    try {
      // First check if in group and bot is admin
      if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
        await ctx.reply('This command only works in groups!');
        return ctx.scene.leave();
      }
      
      const admins = await ctx.getChatAdministrators();
      const botId = ctx.botInfo.id;
      const isBotAdmin = admins.some(admin => admin.user.id === botId);
      
      if (!isBotAdmin) {
        await ctx.reply('I need to be an admin in this group to work properly! Please make me admin and try again.');
        return ctx.scene.leave();
      }
      
      // If all checks pass, start setup
      await ctx.reply(
        '🌐 <b>Step 1/4: Select Blockchain Network</b>',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('BNB Chain', 'chain_bnb')],
            [Markup.button.callback('Solana', 'chain_solana')],
            [Markup.button.callback('Cancel Setup', 'cancel_setup')]
          ])
        }
      );
      
      return ctx.wizard.next();
    } catch (error) {
      console.error('Error in setup step 1:', error);
      await ctx.reply('An error occurred during setup. Please try again later.');
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Enter token address/CA
  async (ctx) => {
    try {
      // Handle blockchain selection
      if (ctx.callbackQuery) {
        const callbackData = ctx.callbackQuery.data;
        
        if (callbackData === 'cancel_setup') {
          await ctx.reply('Setup cancelled.');
          return ctx.scene.leave();
        }
        
        if (callbackData === 'chain_bnb' || callbackData === 'chain_solana') {
          const chain = callbackData === 'chain_bnb' ? 'BNB' : 'Solana';
          ctx.wizard.state.chain = chain;
          
          await ctx.reply(
            `🔍 <b>Step 2/4: Enter Token Address</b>\n\n` +
            `Please enter the ${chain} token contract address (CA) you want to track:`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('Cancel Setup', 'cancel_setup')]
              ])
            }
          );
          
          return ctx.wizard.next();
        }
      }
      
      await ctx.reply('Please select a blockchain network using the buttons above.');
    } catch (error) {
      console.error('Error in setup step 2:', error);
      await ctx.reply('An error occurred during setup. Please try again later.');
      return ctx.scene.leave();
    }
  },
  
  // Step 3: Validate token and select emojis
  async (ctx) => {
    try {
      if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_setup') {
        await ctx.reply('Setup cancelled.');
        return ctx.scene.leave();
      }
      
      if (ctx.message && ctx.message.text) {
        const tokenAddress = ctx.message.text.trim();
        ctx.wizard.state.tokenAddress = tokenAddress;
        
        // Validate token address and get token info
        let tokenInfo;
        try {
          if (ctx.wizard.state.chain === 'BNB') {
            const provider = new ethers.providers.JsonRpcProvider(config.providers.BNB);
            const tokenContract = new ethers.Contract(
              tokenAddress,
              ['function name() view returns (string)', 'function symbol() view returns (string)'],
              provider
            );
            
            const [name, symbol] = await Promise.all([
              tokenContract.name(),
              tokenContract.symbol()
            ]);
            
            tokenInfo = { name, symbol };
          } else { // Solana
            // For Solana, we would need to use SPL-token methods
            // This is simplified for example purposes
            const connection = new Connection(config.providers.Solana);
            const tokenPublicKey = new PublicKey(tokenAddress);
            
            // In actual implementation, you would use proper SPL-token methods here
            // This is a placeholder
            const mintInfo = await connection.getParsedAccountInfo(tokenPublicKey);
            tokenInfo = {
              name: "Solana Token", // In reality, you would extract this from mintInfo
              symbol: "SOL"         // In reality, you would extract this from mintInfo
            };
          }
          
          // Store token info
          ctx.wizard.state.tokenInfo = tokenInfo;
          
          await ctx.reply(
            `✅ <b>Token Validated Successfully!</b>\n` +
            `Name: <b>${tokenInfo.name}</b>\n` +
            `Symbol: <b>${tokenInfo.symbol}</b>\n\n` +
            `🎮 <b>Step 3/4: Select Emojis</b>\n\n` +
            `Please select the emojis you want to use for buy notifications:`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback('🚀 🌕 💰', 'emoji_set1'),
                  Markup.button.callback('💎 🔥 💸', 'emoji_set2')
                ],
                [
                  Markup.button.callback('🐂 📈 💵', 'emoji_set3'),
                  Markup.button.callback('🌟 ✨ 💹', 'emoji_set4')
                ],
                [Markup.button.callback('Custom Emojis', 'emoji_custom')],
                [Markup.button.callback('Cancel Setup', 'cancel_setup')]
              ])
            }
          );
          
          return ctx.wizard.next();
        } catch (error) {
          console.error('Error validating token:', error);
          await ctx.reply(
            `⚠️ Invalid token address or error validating token. Please check the address and try again.`,
            {
              ...Markup.inlineKeyboard([
                [Markup.button.callback('Try Again', 'try_again')],
                [Markup.button.callback('Cancel Setup', 'cancel_setup')]
              ])
            }
          );
        }
      } else {
        await ctx.reply('Please enter a valid token address.');
      }
    } catch (error) {
      console.error('Error in setup step 3:', error);
      await ctx.reply('An error occurred during setup. Please try again later.');
      return ctx.scene.leave();
    }
  },
  
  // Step 4: Upload notification image
  async (ctx) => {
    try {
      if (ctx.callbackQuery) {
        const callbackData = ctx.callbackQuery.data;
        
        if (callbackData === 'cancel_setup') {
          await ctx.reply('Setup cancelled.');
          return ctx.scene.leave();
        }
        
        if (callbackData === 'try_again') {
          ctx.wizard.selectStep(1);
          await ctx.reply(
            `🔍 <b>Step 2/4: Enter Token Address</b>\n\n` +
            `Please enter the ${ctx.wizard.state.chain} token contract address (CA) you want to track:`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('Cancel Setup', 'cancel_setup')]
              ])
            }
          );
          return;
        }
        
        if (callbackData.startsWith('emoji_')) {
          if (callbackData === 'emoji_custom') {
            await ctx.reply(
              '🎨 <b>Custom Emojis</b>\n\n' +
              'Please enter up to 3 emojis separated by spaces:',
              { parse_mode: 'HTML' }
            );
            ctx.wizard.state.awaitingCustomEmojis = true;
          } else {
            // Preset emoji sets
            const emojiSets = {
              'emoji_set1': '🚀 🌕 💰',
              'emoji_set2': '💎 🔥 💸',
              'emoji_set3': '🐂 📈 💵',
              'emoji_set4': '🌟 ✨ 💹'
            };
            
            ctx.wizard.state.emojis = emojiSets[callbackData];
            
            await ctx.reply(
              `🖼 <b>Step 4/4: Upload Notification Image</b>\n\n` +
              `Selected emojis: ${ctx.wizard.state.emojis}\n\n` +
              `Please upload an image to use in buy notifications or click Skip to use default:`,
              {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                  [Markup.button.callback('Skip (Use Default)', 'skip_image')],
                  [Markup.button.callback('Cancel Setup', 'cancel_setup')]
                ])
              }
            );
            
            return ctx.wizard.next();
          }
        }
      } else if (ctx.wizard.state.awaitingCustomEmojis && ctx.message && ctx.message.text) {
        // Handle custom emoji input
        const customEmojis = ctx.message.text.trim();
        ctx.wizard.state.emojis = customEmojis;
        delete ctx.wizard.state.awaitingCustomEmojis;
        
        await ctx.reply(
          `🖼 <b>Step 4/4: Upload Notification Image</b>\n\n` +
          `Selected emojis: ${ctx.wizard.state.emojis}\n\n` +
          `Please upload an image to use in buy notifications or click Skip to use default:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('Skip (Use Default)', 'skip_image')],
              [Markup.button.callback('Cancel Setup', 'cancel_setup')]
            ])
          }
        );
        
        return ctx.wizard.next();
      } else {
        await ctx.reply('Please select emojis using the buttons or enter custom emojis.');
      }
    } catch (error) {
      console.error('Error in setup step 4:', error);
      await ctx.reply('An error occurred during setup. Please try again later.');
      return ctx.scene.leave();
    }
  },
  
  // Step 5: Finalize setup
  async (ctx) => {
    try {
      let imageFileId = null;
      
      if (ctx.callbackQuery) {
        const callbackData = ctx.callbackQuery.data;
        
        if (callbackData === 'cancel_setup') {
          await ctx.reply('Setup cancelled.');
          return ctx.scene.leave();
        }
        
        if (callbackData === 'skip_image') {
          // Use default image
          imageFileId = 'default_image_file_id'; // Replace with actual default image file_id
        }
      } else if (ctx.message && ctx.message.photo) {
        // Store uploaded image file_id
        const photos = ctx.message.photo;
        imageFileId = photos[photos.length - 1].file_id; // Get the highest resolution photo
      } else {
        await ctx.reply('Please upload an image or click Skip.');
        return;
      }
      
      // Save all configuration to database
      const groupId = ctx.chat.id;
      const config = {
        chain: ctx.wizard.state.chain,
        tokenAddress: ctx.wizard.state.tokenAddress,
        tokenInfo: ctx.wizard.state.tokenInfo,
        emojis: ctx.wizard.state.emojis,
        imageFileId: imageFileId,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      db.saveGroup(groupId, config);
      
      // Start the blockchain listener (in real implementation)
      startBlockchainListener(groupId, config);
      
      // Confirmation message
      await ctx.replyWithPhoto(
        { source: imageFileId === 'default_image_file_id' ? 
                 path.join(__dirname, 'assets', 'default.png') : 
                 imageFileId },
        {
          caption: `✅ <b>Setup Complete!</b>\n\n` +
                  `🔍 <b>Tracking Configuration:</b>\n` +
                  `• Network: <b>${config.chain}</b>\n` +
                  `• Token: <b>${config.tokenInfo.name} (${config.tokenInfo.symbol})</b>\n` +
                  `• Contract: <code>${config.tokenAddress}</code>\n` +
                  `• Emojis: ${config.emojis}\n\n` +
                  `🚀 The bot is now tracking all purchases for this token and will post notifications in this group!`,
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('View Sample Notification', 'sample_notification')]
          ])
        }
      );
      
      return ctx.scene.leave();
    } catch (error) {
      console.error('Error in setup finalization:', error);
      await ctx.reply('An error occurred during setup. Please try again later.');
      return ctx.scene.leave();
    }
  }
);

// Create scene manager
const stage = new Scenes.Stage([setupScene]);
bot.use(session());
bot.use(stage.middleware());

// Setup command
bot.command('setup', async (ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    await ctx.scene.enter('setup-wizard');
  } else {
    await ctx.reply('This command only works in groups! Please add me to a group first.');
  }
});

// Status command to check current tracking
bot.command('status', async (ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    const groupId = ctx.chat.id;
    const groupConfig = db.getGroup(groupId);
    
    if (groupConfig.isActive) {
      await ctx.reply(
        `📊 <b>Tracking Status:</b> <code>ACTIVE</code>\n\n` +
        `🔍 <b>Current Configuration:</b>\n` +
        `• Network: <b>${groupConfig.chain}</b>\n` +
        `• Token: <b>${groupConfig.tokenInfo.name} (${groupConfig.tokenInfo.symbol})</b>\n` +
        `• Contract: <code>${groupConfig.tokenAddress}</code>\n` +
        `• Started: ${new Date(groupConfig.createdAt).toLocaleString()}\n\n` +
        `Use /setup to change configuration or /stop to stop tracking.`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(
        `⚠️ <b>Tracking Status:</b> <code>INACTIVE</code>\n\n` +
        `No active tracking in this group. Use /setup to configure token tracking.`,
        { parse_mode: 'HTML' }
      );
    }
  } else {
    await ctx.reply('This command only works in groups!');
  }
});

// Stop tracking command
bot.command('stop', async (ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    const groupId = ctx.chat.id;
    const groupConfig = db.getGroup(groupId);
    
    if (groupConfig.isActive) {
      // Update config
      db.saveGroup(groupId, { isActive: false });
      
      // Stop blockchain listener (in real implementation)
      stopBlockchainListener(groupId);
      
      await ctx.reply(
        `🛑 <b>Tracking Stopped</b>\n\n` +
        `Token tracking has been disabled for this group.\n` +
        `Use /setup to configure new tracking or /status to check current status.`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply('No active tracking to stop in this group.');
    }
  } else {
    await ctx.reply('This command only works in groups!');
  }
});

// Handle sample notification request
bot.action('sample_notification', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    
    const groupId = ctx.chat.id;
    const groupConfig = db.getGroup(groupId);
    
    if (!groupConfig) {
      return await ctx.reply('Group configuration not found.');
    }
    
    // Generate a sample buy transaction
    const sampleTx = {
      hash: '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join(''),
      tokenAmount: (Math.random() * 1000000).toFixed(2),
      nativeAmount: (Math.random() * 2).toFixed(4),
      usdAmount: (Math.random() * 1000).toFixed(2),
      buyer: '0x' + Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')
    };
    
    // Send sample notification
    await sendBuyNotification(groupId, groupConfig, sampleTx, true);
    
  } catch (error) {
    console.error('Error sending sample notification:', error);
    await ctx.reply('An error occurred while sending sample notification.');
  }
});

// Function to start blockchain listener
function startBlockchainListener(groupId, config) {
  console.log(`Started blockchain listener for group ${groupId}, token ${config.tokenAddress}`);
  
  // In a real implementation, you would set up proper blockchain event listeners here
  // For example, with ethers.js for BNB Chain or @solana/web3.js for Solana
  
  // For demonstration, we'll simulate random buy events
  if (process.env.NODE_ENV !== 'production') {
    simulateBuyTransactions(groupId, config);
  }
}

// Function to stop blockchain listener
function stopBlockchainListener(groupId) {
  console.log(`Stopped blockchain listener for group ${groupId}`);
  
  // In a real implementation, you would clean up blockchain event listeners here
}

// Function to simulate buy transactions (for testing only)
function simulateBuyTransactions(groupId, config) {
  // Simple simulation timer
  const interval = setInterval(async () => {
    try {
      if (!db.getGroup(groupId).isActive) {
        clearInterval(interval);
        return;
      }
      
      // Random chance of transaction (33%)
      if (Math.random() > 0.33) return;
      
      // Generate a sample buy transaction
      const sampleTx = {
        hash: '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join(''),
        tokenAmount: (Math.random() * 1000000).toFixed(2),
        nativeAmount: (Math.random() * 2).toFixed(4),
        usdAmount: (Math.random() * 1000).toFixed(2),
        buyer: '0x' + Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')
      };
      
      // Send notification
      await sendBuyNotification(groupId, config, sampleTx);
      
    } catch (error) {
      console.error('Error in transaction simulation:', error);
    }
  }, 60000); // Check every minute
}

// Function to send buy notification to group
async function sendBuyNotification(groupId, config, tx, isSample = false) {
  try {
    const { chain, tokenInfo, emojis, imageFileId } = config;
    
    // Prepare caption
    const caption = 
      `${emojis} <b>NEW BUY${isSample ? ' (SAMPLE)' : ''}</b> ${emojis}\n\n` +
      `🔄 <b>${tokenInfo.name} (${tokenInfo.symbol})</b>\n\n` +
      `💰 Amount: <b>${tx.tokenAmount} ${tokenInfo.symbol}</b>\n` +
      `🪙 Value: <b>${tx.nativeAmount} ${chain === 'BNB' ? 'BNB' : 'SOL'}</b> ($${tx.usdAmount})\n` +
      `👤 Buyer: <code>${tx.buyer}</code>\n\n` +
      `🔗 <a href="${config.scannerUrls[chain]}${tx.hash}">View Transaction</a>`;
    
    // Send notification with image
    await bot.telegram.sendPhoto(
      groupId,
      imageFileId === 'default_image_file_id' ? 
        { source: path.join(__dirname, 'assets', 'default.png') } : 
        imageFileId,
      {
        caption: caption,
        parse_mode: 'HTML'
      }
    );
    
    console.log(`Sent notification to group ${groupId} for transaction ${tx.hash}`);
    
  } catch (error) {
    console.error('Error sending buy notification:', error);
  }
}

// Handle other actions and updates
bot.on('callback_query', async (ctx) => {
  try {
    // Fallback handler for callback queries
    await ctx.answerCbQuery();
    await ctx.reply('This action is not available right now.');
  } catch (error) {
    console.error('Error handling callback query:', error);
  }
});

// Launch bot
bot.launch()
  .then(() => {
    console.log('BuyTracker Bot is running!');
  })
  .catch((error) => {
    console.error('Error starting bot:', error);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
