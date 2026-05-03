import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import errorHandler from './middlewares/error.middleware.js';
import { PORT } from './config/env.js';
import authRouter from './routes/auth.route.js';
import leadRouter from './routes/lead.route.js';
import invoiceRouter from './routes/invoice.route.js';
import payoutRouter from './routes/payout.route.js';
import commissionRouter from './routes/commission.route.js';
import dashboardRouter from './routes/dashboard.route.js';
import franchiseRouter from './routes/franchise.route.js';
import relationshipManagerRouter from './routes/relationshipManager.route.js';
import bankRouter from './routes/bank.route.js';
import leadFormRouter from './routes/leadForm.route.js';
import fieldDefRouter from './routes/fieldDef.route.js';
import userRouter from './routes/user.route.js';
import documentRouter from './routes/document.route.js';
import reportRouter from './routes/report.route.js';
import agentRouter from './routes/agent.route.js';
import staffRouter from './routes/staff.route.js';
import bankManagerRouter from './routes/bankManager.route.js';
import accountantManagerRouter from './routes/accountantManager.route.js';
import accountantRouter from './routes/accountantDashboard.route.js';
import historyRouter from './routes/history.route.js';
import bannerRouter from './routes/banner.route.js';
import form16Router from './routes/form16.route.js';
import ticketRouter from './routes/ticket.route.js';
import notificationRouter from './routes/notification.route.js';
import franchiseCommissionLimitRouter from './routes/franchiseCommissionLimit.route.js';
import companySettingsRouter from './routes/companySettings.route.js';
import { startTicketEscalationJob } from './jobs/ticketEscalation.job.js';
import connectDB from './config/db.js';
import { seedDefaultAdmin } from './utils/seedAdmin.js';
import { seedSampleBankAndManager } from './utils/seedBankAndManager.js';
import { seedFieldDefinitions } from './utils/seedFieldDefinitions.js';
import { v2 as cloudinary } from 'cloudinary';

const app = express();

// Middleware
app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
    "https://ykcfinserv.com",
    "https://www.ykcfinserv.com",
    "https://ykc-finserv.vercel.app"
  ],
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Root route
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'YKC FinServ API Server is running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api/*'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
  });
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/leads', leadRouter);
app.use('/api/invoices', invoiceRouter);
app.use('/api/payouts', payoutRouter);
app.use('/api/commissions', commissionRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/franchises', franchiseRouter);
app.use('/api/relationship-managers', relationshipManagerRouter);
app.use('/api/banks', bankRouter);
app.use('/api/lead-forms', leadFormRouter);
app.use('/api/users', userRouter);
app.use('/api/documents', documentRouter);
app.use('/api/reports', reportRouter);
app.use('/api/agents', agentRouter);
app.use('/api/staff', staffRouter);
app.use('/api/bank-managers', bankManagerRouter);
app.use('/api/accountant-managers', accountantManagerRouter);
app.use('/api/accountant', accountantRouter);
app.use('/api/field-defs', fieldDefRouter);
app.use('/api/history', historyRouter);
app.use('/api/banners', bannerRouter);
app.use('/api/form16', form16Router);
app.use('/api/tickets', ticketRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/franchise-commission-limits', franchiseCommissionLimitRouter);
app.use('/api/company-settings', companySettingsRouter);

// Error handler (must be last)
app.use(errorHandler);

// Start server and connect to database
const startServer = async () => {
  try {
    // Connect to MongoDB first
    await connectDB();

    // Configure Cloudinary if env variables are present
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      console.log('Cloudinary configured. (api_key:', process.env.CLOUDINARY_API_KEY ? 'present' : 'missing' + ')');
    } else {
      console.log('Cloudinary not configured - uploads will use local storage.');
    }

    // Create default admin user if it doesn't exist
    await seedDefaultAdmin();

    // Create a sample bank and bank manager if none exist (useful for local dev)
    await seedSampleBankAndManager();

    // Seed default field definitions (Lead Name, Mobile, Email, Address)
    await seedFieldDefinitions();

    // Start ticket escalation cron job
    startTicketEscalationJob();

    // Start Express server
    app.listen(PORT, () => {
      console.log("\n" + "=".repeat(60));
      console.log("🚀 Server Started Successfully!");
      console.log("=".repeat(60));
      console.log(`📍 Server URL: http://localhost:${PORT}`);
      console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`💚 Health Check: http://localhost:${PORT}/health`);
      console.log("=".repeat(60) + "\n");
    });
  } catch (error) {
    console.error("\n❌ Failed to start server!");
    console.error("Error:", error.message);
    process.exit(1);
  }
};

startServer();
