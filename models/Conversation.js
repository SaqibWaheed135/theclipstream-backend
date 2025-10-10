import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  isGroup: { type: Boolean, default: false },
  // groupName: { type: String, maxLength: 50 },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },

  groupAvatar: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

conversationSchema.index({ participants: 1 });
conversationSchema.index({ updatedAt: -1 });

// conversationSchema.pre('save', function(next) {
//   if (this.participants.length < 2) {
//     return next(new Error('Conversation must have at least 2 participants'));
//   }
//   next();
// });
conversationSchema.pre('save', function(next) {
  // Only enforce 2 participants for non-group chats
  if (!this.isGroup && this.participants.length < 2) {
    return next(new Error('Conversation must have at least 2 participants'));
  }
  next();
});


const Conversation = mongoose.model('Conversation', conversationSchema);
export default Conversation;
