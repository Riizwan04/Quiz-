// MongoDB connection and Mongoose models.

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true }, // bcrypt hash, never the plain password
  createdAt: { type: Date, default: Date.now },
});

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    options: {
      type: [String],
      required: true,
      validate: { validator: (v) => v.length === 4, message: 'A question needs exactly 4 options' },
    },
    correctIndex: { type: Number, required: true, min: 0, max: 3 },
    timeLimit: { type: Number, required: true, min: 5, max: 120 }, // seconds
  },
  { _id: false },
);

const quizSchema = new mongoose.Schema({
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true },
  questions: { type: [questionSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

const scoreSchema = new mongoose.Schema(
  {
    rank: Number,
    name: String,
    avatar: String,
    points: Number,
    accuracy: Number, // percent of questions answered correctly, 0-100
    correct: Number,
    total: Number,
    fastestMs: Number,
  },
  { _id: false },
);

const resultSchema = new mongoose.Schema({
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  quizTitle: String, // kept so results still read well if the quiz is later deleted
  roomPin: String,
  scores: { type: [scoreSchema], default: [] },
  date: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Quiz = mongoose.model('Quiz', quizSchema);
const Result = mongoose.model('Result', resultSchema);

async function connect(uri) {
  mongoose.connection.on('disconnected', () => console.warn('[db] MongoDB disconnected; live games keep running, saving will retry when it reconnects.'));
  mongoose.connection.on('reconnected', () => console.log('[db] MongoDB reconnected.'));
  mongoose.connection.on('error', (err) => console.error('[db] MongoDB error:', err.message));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([User.init(), Quiz.init(), Result.init()]); // build indexes (unique email)
}

module.exports = { connect, mongoose, User, Quiz, Result };
