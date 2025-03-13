import { config } from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import axios from 'axios';

// Add debug logging
const debug = (message) => {
  if (process.env.DEBUG_MODE === 'true') {
    console.log(`[DEBUG] ${message}`);
  }
};

// Update ERC20 ABI with more complete interface
const ERC20_ABI = [
  {
    "constant": true,
    "inputs": [],
    "name": "name",
    "outputs": [{"name": "", "type": "string"}],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "symbol",
    "outputs": [{"name": "", "type": "string"}],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{"name": "", "type": "uint8"}],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true, "name": "from", "type": "address"},
      {"indexed": true, "name": "to", "type": "address"},
      {"indexed": false, "name": "value", "type": "uint256"}
    ],
    "name": "Transfer",
    "type": "event"
  }
];

// Global references
let provider;
let bot;
let botInfo; // Store bot info globally

// Helper function to safely access bot info
const getBotInfo = async (forceRefresh = false) => {
  try {
    if (!botInfo || forceRefresh) {
      botInfo = await bot.getMe();
      debug(`Bot info ${forceRefresh ? 'refreshed' : 'retrieved'}: @${botInfo.username} (${botInfo.id})`);
    }
    return botInfo;
  } catch (error) {
    console.error('Error getting bot info:', error);
    return { username: 'BuyBot', first_name: 'BuyBot' };
  }
};

// Initialize bot function
const initBot = async () => {
  try {
    // Configure dotenv
    config();

    // Get current directory
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // Create data directory
    const dataDir = join(__dirname, 'data');
    mkdirSync(dataDir, { recursive: true });

    // Configure lowdb
    const adapter = new JSONFile(join(dataDir, 'db.json'));
    const defaultData = { groups: [], tokens: [] };
    const db = new Low(adapter, defaultData);

    // Initialize database
    await db.read();
    if (!db.data) {
      db.data = defaultData;
      await db.write();
    }

    // Ensure groups array exists
    if (!db.data.groups) {
      db.data.groups = [];
    }

    // Handle migration from old format (tokens array) to new format (group.token)
    if (Array.isArray(db.data.tokens) && db.data.tokens.length > 0) {
      debug('Migrating from old format to new format');
      
      // For each token in the old format, create a group entry if it doesn't exist
      for (const token of db.data.tokens) {
        if (!token.groupId) continue;

        // Check if group already exists
        const existingGroup = db.data.groups.find(g => g.id === token.groupId);
        if (existingGroup) {
          // Update existing group with token data
          existingGroup.token = {
            address: token.address.toLowerCase(),
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            emoji: token.emoji || '🚀',
            updatedAt: Date.now()
          };
        } else {
          // Create new group with token data
          db.data.groups.push({
            id: token.groupId,
            admins: [],
            chainId: process.env.CHAIN_ID || 1,
            notificationsEnabled: true,
            token: {
              address: token.address.toLowerCase(),
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              emoji: token.emoji || '🚀',
              updatedAt: Date.now()
            },
            createdAt: token.createdAt || Date.now()
          });
        }
      }
      
      // Keep tokens array for backward compatibility
      debug(`Migrated ${db.data.tokens.length} tokens to new format`);
      
      // Save the updated structure
      await db.write();
    }

    // Initialize bot
    bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { 
      polling: true,
      filepath: false // Disable file handling to prevent some errors
    });

    // Get bot information and store it
    botInfo = await bot.getMe();
    debug(`Bot initialized: @${botInfo.username} (ID: ${botInfo.id})`);

    // Initialize provider
    provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

    // Add error handlers
    bot.on('polling_error', (error) => {
      console.error('Polling error:', error);
    });

    bot.on('error', (error) => {
      console.error('Bot error:', error);
    });

    console.log('✅ Bot initialized successfully');
    return { bot, provider, db };
  } catch (error) {
    console.error('❌ Error initializing bot:', error);
    process.exit(1);
  }
};

// Start bot
const startBot = async () => {
  const { bot, provider, db } = await initBot();

  // Message templates with buttons
  const getWelcomeMessage = () => {
    return {
      text: `🤖 <b>Welcome to BuyBot!</b>

This bot tracks token purchases on the blockchain and sends notifications to your group.

<b>Quick Start Guide:</b>
1. Add this bot to your group
2. Make the bot an admin
3. Setup the bot
4. Add a token to track

Use the buttons below to get started.`,
      options: {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: '➕ Add to Group', 
                url: `https://t.me/${bot.options.username}?startgroup=true` 
              }
            ],
            [
              { text: '📚 Help', callback_data: 'help' },
              { text: '❓ About', callback_data: 'about' }
            ]
          ]
        }
      }
    };
  };

  const getGroupWelcomeMessage = () => {
    return {
      text: `🎉 <b>Thanks for adding ${botInfo ? botInfo.first_name : 'BuyBot'}!</b>

To get started:
1️⃣ Make me an admin in this group with these permissions:
   • Delete messages
   • Send messages
   • Pin messages

2️⃣ Click the Setup button below
3️⃣ Add a token to track

<b>Need help?</b> Use the Help button`,
      options: {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⚙️ Setup Bot', callback_data: 'setup' }
            ],
            [
              { text: '🛠️ Admin Settings', callback_data: 'admin_settings' },
              { text: '📚 Help', callback_data: 'help' }
            ]
          ]
        }
      }
    };
  };

  const getMainMenuMessage = (chatId) => {
    return {
      text: `🤖 <b>BuyBot Main Menu</b>

Select an option below:`,
      options: {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🪙 Set Token', callback_data: 'set_token' }
            ],
            [
              { text: '📊 Status', callback_data: 'status' },
              { text: '⚙️ Settings', callback_data: 'settings' }
            ],
            [
              { text: '📚 Help', callback_data: 'help' }
            ]
          ]
        }
      }
    };
  };

  const getHelpMessage = () => {
    return {
      text: `📚 <b>BuyBot Help</b>

This bot tracks token purchases and sends notifications to your group.

<b>Setup Steps:</b>
1. Add the bot to your group
2. Make the bot an admin
3. Use the Setup button
4. Set a token to track

<b>Features:</b>
• Track token purchases in real-time
• Receive notifications in your group
• View transaction details

<b>Need more help?</b>
Contact @YourSupportUsername`,
      options: {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⬅️ Back to Menu', callback_data: 'main_menu' }
            ]
          ]
        }
      }
    };
  };

  // Helper functions for database operations
  const dbHelper = {
    // Add or update group with admin
    addGroup: async (groupId, adminId) => {
      // Make sure db.data is initialized
      if (!db.data) {
        db.data = { groups: [] };
      }
      
      // Initialize groups array if needed
      if (!Array.isArray(db.data.groups)) {
        db.data.groups = [];
      }
      
      // Check if group already exists
      const existingGroup = db.data.groups.find(g => g.id === groupId.toString());
      
      if (existingGroup) {
        // If group exists, make sure admin is added
        if (!existingGroup.admins.includes(adminId.toString())) {
          existingGroup.admins.push(adminId.toString());
        }
        await db.write();
        return existingGroup;
      }
      
      // Create new group
      const group = {
        id: groupId.toString(),
        admins: [adminId.toString()],
        chainId: process.env.CHAIN_ID || 1,
        token: null, // Only one token per group
        createdAt: Date.now()
      };
      db.data.groups.push(group);
      await db.write();
      return group;
    },

    // Check if user is admin
    isAdmin: (groupId, userId) => {
      const group = db.data.groups.find(g => g.id === groupId.toString());
      return group && group.admins.includes(userId.toString());
    },

    // Set token for group
    setToken: async (groupId, tokenInfo) => {
      const group = db.data.groups.find(g => g.id === groupId.toString());
      if (!group) return false;
      
      group.token = {
        address: tokenInfo.address.toLowerCase(),
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
        emoji: '🚀',
        updatedAt: Date.now()
      };
      
      await db.write();
      return true;
    },

    // Check if user is group admin
    isGroupAdmin: async (bot, chatId, userId) => {
      try {
        const member = await bot.getChatMember(chatId, userId);
        return ['creator', 'administrator'].includes(member.status);
      } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
      }
    },

    // Get group settings
    getGroupSettings: async (groupId) => {
      const group = db.data.groups.find(g => g.id === groupId.toString());
      if (!group) {
        // Create default settings for new group
        const defaultSettings = {
          id: groupId.toString(),
          chainId: process.env.CHAIN_ID || 1,
          notificationsEnabled: true,
          token: null,
          createdAt: Date.now()
        };
        db.data.groups.push(defaultSettings);
        await db.write();
        return defaultSettings;
      }
      return group;
    },

    // Get token for group
    getGroupToken: (groupId) => {
      const group = db.data.groups.find(g => g.id === groupId.toString());
      return group ? group.token : null;
    },
    
    // Get all groups with tokens
    getGroupsWithTokens: () => {
      if (!db.data || !Array.isArray(db.data.groups)) {
        return [];
      }
      return db.data.groups.filter(g => g && g.token !== null && g.token !== undefined);
    },

    // Check if bot has required permissions
    checkBotPermissions: async (chatId) => {
      try {
        // Make sure we have current bot info
        const currentBotInfo = await getBotInfo();
        
        // Get bot as chat member
        debug(`Checking bot permissions in chat ${chatId} for bot ID ${currentBotInfo.id}`);
        const botMember = await bot.getChatMember(chatId, currentBotInfo.id);
        
        // Log detailed permissions for debugging
        debug(`Bot member info: ${JSON.stringify(botMember)}`);
        
        // Check if bot is admin
        if (botMember.status !== 'administrator') {
          debug(`Bot is not admin in chat ${chatId}, status: ${botMember.status}`);
          return { 
            isAdmin: false,
            status: botMember.status,
            message: 'The bot needs to be an admin in this group'
          };
        }
        
        // Special handling for supergroups where permissions might be structured differently
        const isSupergroup = chatId.toString().startsWith('-100');
        debug(`Group ${chatId} is ${isSupergroup ? 'a supergroup' : 'a regular group'}`);
        
        // Get chat info to confirm supergroup status
        const chatInfo = await bot.getChat(chatId);
        debug(`Chat info: ${JSON.stringify(chatInfo)}`);
        
        // Check permissions with more lenient checks for supergroups
        const canSendMessages = botMember.can_send_messages || 
                              botMember.can_post_messages || 
                              botMember.status === 'administrator';
        
        const canDeleteMessages = botMember.can_delete_messages;
        const canPinMessages = botMember.can_pin_messages;
        
        debug(`Permissions - send: ${canSendMessages}, delete: ${canDeleteMessages}, pin: ${canPinMessages}`);
        
        const missingPermissions = [];
        if (!canSendMessages) missingPermissions.push('send messages');
        if (!canDeleteMessages) missingPermissions.push('delete messages');
        if (!canPinMessages) missingPermissions.push('pin messages');
        
        if (missingPermissions.length > 0) {
          return {
            isAdmin: true,
            hasPermissions: false,
            missingPermissions: missingPermissions,
            message: `Bot is missing these permissions: ${missingPermissions.join(', ')}`
          };
        }
        
        return { isAdmin: true, hasPermissions: true };
      } catch (error) {
        console.error('Error checking bot permissions:', error);
        debug(`Full permission check error: ${JSON.stringify(error, null, 2)}`);
        
        // Try with a fallback method for supergroups
        try {
          const chatInfo = await bot.getChat(chatId);
          debug(`Fallback - Chat info: ${JSON.stringify(chatInfo)}`);
          
          // If we can get chat info, we have some permissions
          return { 
            isAdmin: true,
            hasPermissions: true,
            isRecoveryMode: true,
            message: 'Using fallback permission detection'
          };
        } catch (fallbackError) {
          return { 
            isAdmin: false,
            error: true,
            message: 'Could not verify bot permissions'
          };
        }
      }
    },
  };

  // Setup wizard with improved permission checking
  const setupBot = async (chatId, userId) => {
    try {
      debug(`Starting setup for chat ${chatId} and user ${userId}`);
      
      // Check if group
      const chat = await bot.getChat(chatId);
      debug(`Chat info: ${JSON.stringify(chat)}`);
      
      if (chat.type === 'private') {
        debug('Setup attempted in private chat');
        return bot.sendMessage(chatId, 
          '⚠️ Please add me to a group first and then setup the bot in that group!'
        );
      }

      // Check user admin rights
      debug(`Checking admin rights for user ${userId}`);
      const member = await bot.getChatMember(chatId, userId);
      if (!['creator', 'administrator'].includes(member.status)) {
        debug(`User ${userId} is not an admin (status: ${member.status})`);
        return bot.sendMessage(chatId,
          '⚠️ You need to be a group admin to setup the bot!'
        );
      }

      // Make sure we have the latest bot info
      const currentBotInfo = await getBotInfo(true);
      debug(`Current bot info: ${JSON.stringify(currentBotInfo)}`);

      // Check bot permissions with enhanced debugging
      debug(`Checking bot permissions for ${currentBotInfo.id} in chat ${chatId}`);
      const permissionCheck = await dbHelper.checkBotPermissions(chatId);
      debug(`Permission check result: ${JSON.stringify(permissionCheck)}`);
      
      if (!permissionCheck.isAdmin) {
        // Bot is not an admin yet
        return bot.sendMessage(chatId, 
          `⚠️ I need to be an admin in this group to work properly.\n\n` +
          `<b>How to make the bot an admin:</b>\n` +
          `1️⃣ Open your group settings\n` +
          `2️⃣ Go to Administrators\n` +
          `3️⃣ Add Administrator\n` +
          `4️⃣ Select @${currentBotInfo.username}\n` +
          `5️⃣ Enable these permissions:\n` +
          `   • Delete messages\n` +
          `   • Pin messages\n` +
          `   • Send messages\n\n` +
          `After making me an admin, click the Setup button again.\n\n` +
          `Debug info: Bot ID ${currentBotInfo.id}, Status: ${permissionCheck.status || 'unknown'}`,
          { 
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Check Again', callback_data: 'setup' }],
                [{ text: '🔍 Debug Info', callback_data: 'debug_bot' }]
              ]
            }
          }
        );
      } else if (!permissionCheck.hasPermissions && !permissionCheck.isRecoveryMode) {
        // Bot is admin but missing permissions
        return bot.sendMessage(chatId, 
          `⚠️ I'm an admin, but missing some required permissions.\n\n` +
          `<b>Please enable these permissions:</b>\n` +
          `${permissionCheck.missingPermissions.map(p => `• ${p}`).join('\n')}\n\n` +
          `<b>How to fix:</b>\n` +
          `1️⃣ Open your group settings\n` +
          `2️⃣ Go to Administrators\n` +
          `3️⃣ Find @${currentBotInfo.username}\n` +
          `4️⃣ Edit permissions\n\n` +
          `After updating permissions, click the Check Again button.`,
          { 
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Check Again', callback_data: 'setup' }]
              ]
            }
          }
        );
      }

      // Create or update group
      debug(`Adding/updating group ${chatId}`);
      await db.read(); // Make sure we have latest data
      const group = await dbHelper.addGroup(chatId, userId);
      debug(`Group data: ${JSON.stringify(group)}`);

      // Success message with buttons
      const message = {
        text: `✅ <b>Setup Complete!</b>

Your group has been configured successfully with @${botInfo.username}.

Now you need to:
1️⃣ Set a token to track using the button below
2️⃣ The bot will automatically monitor purchases 
3️⃣ You'll get notifications in this group`,
        options: {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🪙 Set Token', callback_data: 'set_token' }
              ],
              [
                { text: '📊 Status', callback_data: 'status' },
                { text: '⚙️ Settings', callback_data: 'settings' }
              ]
            ]
          }
        }
      };

      debug('Sending setup success message');
      await bot.sendMessage(chatId, message.text, message.options);

    } catch (error) {
      console.error(`Setup error for chat ${chatId}:`, error);
      debug(`Full setup error: ${JSON.stringify(error, null, 2)}`);
      
      try {
        // Get current bot info to ensure the message is accurate
        const currentBotInfo = await getBotInfo();
        
        await bot.sendMessage(chatId,
          `❌ Error during setup. Please make sure @${currentBotInfo.username} has admin rights in the group!\n\n` +
          `If problem persists, try adding the bot again or use the Debug button below.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 Debug Bot Status', callback_data: 'debug_bot' }],
                [{ text: '🔄 Try Again', callback_data: 'setup' }]
              ]
            }
          }
        );
      } catch (sendError) {
        console.error('Error sending error message:', sendError);
      }
    }
  };

  // Token setup flow
  const startSetToken = async (chatId) => {
    const message = {
      text: `🪙 <b>Set Token to Track</b>

Please enter the contract address of the token you want to track:

<i>Example: 0x6982508145454ce325ddbe47a25d4ec3d2311933</i>`,
      options: {
        parse_mode: 'HTML',
        reply_markup: {
          force_reply: true
        }
      }
    };

    const sentMsg = await bot.sendMessage(chatId, message.text, message.options);
    
    // Store in temp data that we're expecting a token address
    userStates[chatId] = {
      waitingFor: 'token_address',
      messageId: sentMsg.message_id
    };
  };

  // Processing token address input
  const processTokenAddress = async (msg) => {
    const chatId = msg.chat.id;
    const address = msg.text.trim();
    
    // Send loading message
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Getting token information...');

    try {
      // Validate address
      const validAddress = ethers.utils.getAddress(address);
      
      // Create contract instance
      const tokenContract = new ethers.Contract(validAddress, ERC20_ABI, provider);
      
      debug(`Getting token info for ${validAddress}`);

      // Get token info
      let [name, symbol, decimals] = await Promise.all([
        tokenContract.name().catch(() => 'Unknown'),
        tokenContract.symbol().catch(() => 'UNKNOWN'),
        tokenContract.decimals().catch(() => 18)
      ]);
      
      debug(`Token info retrieved: ${name} (${symbol}) - ${decimals} decimals`);

      // Update group with token
      await db.read();
      await dbHelper.setToken(chatId.toString(), {
        address: validAddress,
        name,
        symbol,
        decimals
      });

      // Success message with confirmation
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      
      // Create and start listening to token events
      setupTokenListener(chatId.toString(), validAddress);
      
      const message = {
        text: `✅ <b>Token Set Successfully!</b>

<b>Token Details:</b>
Name: ${name}
Symbol: ${symbol}
Address: <code>${validAddress}</code>

The bot is now tracking purchases for this token and will send notifications to this group.`,
        options: {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📊 Status', callback_data: 'status' }
              ],
              [
                { text: '⬅️ Main Menu', callback_data: 'main_menu' }
              ]
            ]
          }
        }
      };
      
      await bot.sendMessage(chatId, message.text, message.options);

    } catch (error) {
      debug(`Token add error: ${error.message}`);
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      await bot.sendMessage(chatId, 
        '❌ Could not set token. Make sure this is a valid ERC20 contract address.\n\nPlease try again with a different address.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Try Again', callback_data: 'set_token' }
              ],
              [
                { text: '⬅️ Main Menu', callback_data: 'main_menu' }
              ]
            ]
          }
        }
      );
    }
  };

  // Setup token listener for purchases
  const tokenListeners = {};

  const setupTokenListener = async (groupId, tokenAddress) => {
    // Remove existing listener if any
    if (tokenListeners[groupId]) {
      tokenListeners[groupId].removeAllListeners('Transfer');
      debug(`Removed existing listener for group ${groupId}`);
    }

    try {
      // Create token contract
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      
      // Set up event listener for transfers (purchases)
      tokenContract.on('Transfer', async (from, to, amount, event) => {
        debug(`Transfer event detected: ${from} -> ${to}, amount: ${amount.toString()}`);
        
        // We're only interested in purchases (transfers from DEX like Uniswap)
        // Filter for common DEXs
        const dexAddresses = [
          '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
          '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
          '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap Router
          '0x10ed43c718714eb63d5aa57b78b54704e256024e'  // PancakeSwap Router
        ];
        
        const isDexPurchase = dexAddresses.some(dex => 
          from.toLowerCase() === dex.toLowerCase()
        );
        
        if (isDexPurchase) {
          // Get group data
          const group = db.data.groups.find(g => g.id === groupId);
          if (!group || !group.token) return;
          
          // Get token details
          const { name, symbol, decimals } = group.token;
          
          // Format amount
          const formattedAmount = ethers.utils.formatUnits(amount, decimals);
          
          // Get transaction details
          const tx = await provider.getTransaction(event.transactionHash);
          const explorer = process.env.EXPLORER_URL || 'https://etherscan.io/tx/';
          
          // Send notification to group
          const message = {
            text: `${group.token.emoji || '🚨'} <b>Token Purchase Detected!</b>

<b>${name} (${symbol})</b> has been purchased!

<b>Amount:</b> ${parseFloat(formattedAmount).toFixed(4)} ${symbol}
<b>Buyer:</b> <code>${to.slice(0, 6)}...${to.slice(-4)}</code>
<b>Transaction:</b> <a href="${explorer}${event.transactionHash}">View on Explorer</a>

#${symbol} #purchase`,
            options: {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🔍 View Transaction', url: `${explorer}${event.transactionHash}` }
                  ]
                ]
              }
            }
          };
          
          await bot.sendMessage(groupId, message.text, message.options);
          debug(`Sent purchase notification to group ${groupId}`);
        }
      });
      
      debug(`Set up listener for token ${tokenAddress} in group ${groupId}`);
      tokenListeners[groupId] = tokenContract;
      
    } catch (error) {
      console.error(`Error setting up token listener: ${error.message}`);
      debug(`Listener error: ${JSON.stringify(error, null, 2)}`);
    }
  };

  // Start all token listeners on boot
  const startAllTokenListeners = async () => {
    try {
      const groups = dbHelper.getGroupsWithTokens();
      debug(`Starting listeners for ${groups.length} groups with tokens`);
      
      for (const group of groups) {
        if (group.token && group.token.address) {
          try {
            await setupTokenListener(group.id, group.token.address);
            debug(`Started listener for group ${group.id}, token ${group.token.address}`);
          } catch (listenerError) {
            console.error(`Error setting up listener for group ${group.id}:`, listenerError.message);
          }
        }
      }
    } catch (error) {
      console.error('Error starting token listeners:', error);
      debug(`Full error: ${JSON.stringify(error, null, 2)}`);
    }
  };
  
  // Start listeners for existing tokens
  await startAllTokenListeners();

  // User state management for multi-step flows
  const userStates = {};
  
  // Handle callback queries (button clicks)
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    const userId = query.from.id;
    
    debug(`Callback query: ${data} from user ${userId} in chat ${chatId}`);
    
    try {
      // Acknowledge the callback query
      await bot.answerCallbackQuery(query.id);
      
      switch (data) {
        case 'main_menu':
          const mainMenu = getMainMenuMessage(chatId);
          await bot.editMessageText(mainMenu.text, {
            chat_id: chatId,
            message_id: messageId,
            ...mainMenu.options
          });
          break;
          
        case 'setup':
          await setupBot(chatId, userId);
          break;
          
        case 'set_token':
          // Check if user is admin
          const isAdmin = await dbHelper.isGroupAdmin(bot, chatId, userId);
          if (!isAdmin) {
            await bot.sendMessage(chatId, '⚠️ Only group admins can set the token');
            return;
          }
          
          await startSetToken(chatId);
          break;
          
        case 'help':
          const helpMessage = getHelpMessage();
          await bot.editMessageText(helpMessage.text, {
            chat_id: chatId,
            message_id: messageId,
            ...helpMessage.options
          });
          break;
          
        case 'status':
          await db.read();
          const group = await dbHelper.getGroupSettings(chatId.toString());
          const token = group.token;
          
          let statusText = `📊 <b>Bot Status</b>\n\n`;
          
          if (token) {
            statusText += `<b>Currently Tracking:</b>\n`;
            statusText += `Token: ${token.name} (${token.symbol})\n`;
            statusText += `Address: <code>${token.address}</code>\n\n`;
            statusText += `<b>Notifications:</b> ${group.notificationsEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
            statusText += `<b>Network:</b> ${
              group.chainId === 1 ? 'Ethereum' :
              group.chainId === 56 ? 'BSC' :
              group.chainId === 137 ? 'Polygon' : 'Unknown'
            }\n`;
          } else {
            statusText += `❌ <b>No token is currently being tracked</b>\n\n`;
            statusText += `Click the "Set Token" button to start tracking a token.`;
          }
          
          await bot.editMessageText(statusText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🪙 Set Token', callback_data: 'set_token' }
                ],
                [
                  { text: '⬅️ Main Menu', callback_data: 'main_menu' }
                ]
              ]
            }
          });
          break;
          
        case 'settings':
          await bot.editMessageText(`⚙️ <b>Bot Settings</b>`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { 
                    text: '🔔 Toggle Notifications', 
                    callback_data: 'toggle_notifications' 
                  }
                ],
                [
                  { text: '⬅️ Main Menu', callback_data: 'main_menu' }
                ]
              ]
            }
          });
          break;
          
        case 'toggle_notifications':
          await db.read();
          const groupSettings = await dbHelper.getGroupSettings(chatId.toString());
          groupSettings.notificationsEnabled = !groupSettings.notificationsEnabled;
          await db.write();
          
          await bot.sendMessage(
            chatId, 
            `🔔 Notifications are now ${groupSettings.notificationsEnabled ? 'enabled' : 'disabled'}`
          );
          
          // Return to settings
          await bot.editMessageText(`⚙️ <b>Bot Settings</b>`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { 
                    text: `🔔 ${groupSettings.notificationsEnabled ? 'Disable' : 'Enable'} Notifications`, 
                    callback_data: 'toggle_notifications' 
                  }
                ],
                [
                  { text: '⬅️ Main Menu', callback_data: 'main_menu' }
                ]
              ]
            }
          });
          break;
          
        case 'about':
          await bot.editMessageText(`ℹ️ <b>About BuyBot</b>

BuyBot tracks token purchases on the blockchain and sends notifications to your Telegram group.

<b>Features:</b>
• Real-time purchase tracking
• Transaction details with links
• Easy button-based interface

<b>Version:</b> 1.0
<b>Developer:</b> @YourUsername`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '⬅️ Back', callback_data: 'main_menu' }
                ]
              ]
            }
          });
          break;

        case 'admin_settings':
          // Check if the bot is admin
          const permissionCheck = await dbHelper.checkBotPermissions(chatId);
          let adminSettingsText;
          
          if (!permissionCheck.isAdmin) {
            adminSettingsText = `⚠️ <b>Admin Status: Not an Admin</b>\n\n` +
              `I need to be an admin in this group to work properly.\n\n` +
              `<b>How to make me an admin:</b>\n` +
              `1️⃣ Open your group settings\n` +
              `2️⃣ Go to Administrators\n` +
              `3️⃣ Add Administrator\n` +
              `4️⃣ Select @${botInfo.username}\n` +
              `5️⃣ Enable these permissions:\n` +
              `   • Delete messages\n` +
              `   • Pin messages\n` +
              `   • Send messages`;
          } else if (!permissionCheck.hasPermissions) {
            adminSettingsText = `⚠️ <b>Admin Status: Missing Permissions</b>\n\n` +
              `I'm an admin but missing these permissions:\n` +
              `${permissionCheck.missingPermissions.map(p => `• ${p}`).join('\n')}\n\n` +
              `<b>How to fix:</b>\n` +
              `1️⃣ Open your group settings\n` +
              `2️⃣ Go to Administrators\n` +
              `3️⃣ Find @${botInfo.username}\n` +
              `4️⃣ Edit permissions`;
          } else {
            adminSettingsText = `✅ <b>Admin Status: All Set!</b>\n\n` +
              `I have all the required permissions in this group.\n\n` +
              `You can proceed with setting up a token to track.`;
          }
          
          await bot.editMessageText(adminSettingsText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Check Again', callback_data: 'admin_settings' }],
                [{ text: '⬅️ Back', callback_data: 'main_menu' }]
              ]
            }
          });
          break;

        case 'debug_bot':
          try {
            // Fresh bot info
            await getBotInfo(true);
            
            // Get chat info
            const chatInfo = await bot.getChat(chatId);
            
            // Get bot member info
            const botMember = await bot.getChatMember(chatId, botInfo.id);
            
            // Format permission details
            const permDetails = Object.entries(botMember)
              .filter(([key]) => key.startsWith('can_'))
              .map(([key, value]) => `${key.replace('can_', '')}: ${value ? '✅' : '❌'}`)
              .join('\n');

            const debugText = `🔍 <b>Bot Debug Information</b>\n\n` +
              `<b>Bot Details:</b>\n` +
              `Username: @${botInfo.username}\n` +
              `ID: ${botInfo.id}\n` +
              `First Name: ${botInfo.first_name}\n\n` +
              
              `<b>Group Details:</b>\n` +
              `Chat ID: ${chatId}\n` +
              `Type: ${chatInfo.type}\n` +
              `Title: ${chatInfo.title}\n\n` +
              
              `<b>Bot Status:</b> ${botMember.status}\n\n` +
              
              `<b>Permissions:</b>\n` +
              `${permDetails}`;
            
            await bot.editMessageText(debugText, {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🔄 Refresh', callback_data: 'debug_bot' },
                    { text: '🔧 Setup Bot', callback_data: 'setup' }
                  ],
                  [
                    { text: '⬅️ Back', callback_data: 'main_menu' }
                  ]
                ]
              }
            });
          } catch (error) {
            console.error('Error getting debug info:', error);
            
            await bot.editMessageText(
              `❌ <b>Error getting debug information</b>\n\n` +
              `Error: ${error.message}\n\n` +
              `Please make sure the bot is in this chat and has basic permissions.`,
              {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔄 Try Again', callback_data: 'debug_bot' }],
                    [{ text: '⬅️ Back', callback_data: 'main_menu' }]
                  ]
                }
              }
            );
          }
          break;
      }
    } catch (error) {
      console.error(`Error handling callback query: ${error.message}`);
      debug(`Callback error: ${JSON.stringify(error, null, 2)}`);
      
      try {
        await bot.sendMessage(chatId, '❌ Error processing your request. Please try again.');
      } catch (e) {
        console.error('Error sending error message:', e);
      }
    }
  });

  // Handle direct messages and responses
  bot.on('message', async (msg) => {
    // Skip processing if no text
    if (!msg.text) return;
    
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Handle commands
    if (text.startsWith('/')) {
      if (text === '/start') {
        const welcome = getWelcomeMessage();
        await bot.sendMessage(chatId, welcome.text, welcome.options);
      }
      return;
    }
    
    // Handle reply to force_reply (for token address input)
    if (userStates[chatId] && userStates[chatId].waitingFor === 'token_address') {
      // Clear state
      const state = userStates[chatId];
      delete userStates[chatId];
      
      // Process token address
      await processTokenAddress(msg);
    }
  });

  // Handle group additions with improved bot identification
  bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    const newMembers = msg.new_chat_members;
    
    // Make sure we have current bot info
    const currentBotInfo = await getBotInfo();
    
    // Check if bot was added to group
    if (newMembers.some(member => member.id === currentBotInfo.id)) {
      debug(`Bot added to group ${chatId}`);
      
      // Add a small delay to ensure permissions have been set
      setTimeout(async () => {
        try {
          const groupWelcome = getGroupWelcomeMessage();
          await bot.sendMessage(chatId, groupWelcome.text, groupWelcome.options);
        } catch (error) {
          console.error('Error sending welcome message:', error);
        }
      }, 1000); // 1-second delay
    }
  });

  // Error logging
  bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
    debug(`Full polling error: ${JSON.stringify(error, null, 2)}`);
  });

  console.log('🚀 BuyBot is running!');
  debug('Debug mode enabled');
};

// Run the bot
startBot().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});