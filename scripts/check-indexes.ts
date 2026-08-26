// 在项目根目录执行：npx ts-node scripts/check-indexes.ts
import mongoose from 'mongoose';
import '../src/models/MemoryFact'; // 触发 Schema 注册

async function checkIndexes() {
    const MONGO_URI =
        process.env.MONGODB_URI || 'mongodb://localhost:27017/ltm_test';

    await mongoose.connect(MONGO_URI);

    const indexes = await mongoose.connection.db
        ?.collection('memoryfacts')
        ?.indexes();

    console.log('=== MemoryFact Indexes ===');
    indexes?.forEach?.((idx) => {
        console.log(`Name: ${idx.name}`);
        console.log(`  Keys: ${JSON.stringify(idx.key)}`);
        console.log(`  Unique: ${!!idx.unique}`);
        console.log(`  Sparse: ${!!idx.sparse}`);
        console.log('---');
    });

    await mongoose.disconnect();
}

checkIndexes().catch(console.error);
