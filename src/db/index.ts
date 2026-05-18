import mongoose from 'mongoose';
const MONGODB_URI =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';

const connectDB = async () => {
    try {
        await mongoose.connect(MONGODB_URI, {
            bufferCommands: false,
            autoIndex: false,
        });
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
};

export default connectDB;
