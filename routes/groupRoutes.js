import express from 'express';
import authMiddleware from '../middleware/auth.js';
import Group from '../models/Group.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import s3 from '../utils/s3.js';
import crypto from 'crypto';
import mongoose from 'mongoose';

const router = express.Router();

// Create a new group
router.post('/create', authMiddleware, async (req, res) => {
    try {
        const { name, description, type = 'private', members = [] } = req.body;
        const userId = req.userId;

        if (!name || name.trim().length === 0) {
            return res.status(400).json({ msg: 'Group name is required' });
        }

        // Create conversation - for groups, admin can be the only participant initially
        const participants = [userId, ...members];
        
        const conversation = await Conversation.create({
            participants: participants,
            isGroup: true
        });

        // Generate invite code for public groups
        const inviteCode = type === 'public' ? crypto.randomBytes(8).toString('hex') : null;

        const group = await Group.create({
            name: name.trim(),
            description: description?.trim() || '',
            type,
            admin: userId,
            moderators: [],
            members: [
                { user: userId, role: 'admin', joinedAt: new Date() },
                ...members.map(memberId => ({ user: memberId, role: 'member', joinedAt: new Date() }))
            ],
            conversation: conversation._id,
            inviteCode
        });

        await group.populate('members.user', 'username avatar');
        await group.populate('admin', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            members.forEach(memberId => {
                io.to(`user-${memberId}`).emit('added-to-group', {
                    group,
                    addedBy: userId
                });
            });
        }

        res.status(201).json(group);
    } catch (error) {
        console.error('Create group error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Get all groups for a user
router.get('/my-groups', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const groups = await Group.find({
            'members.user': userId
        })
            .populate('admin', 'username avatar')
            .populate('members.user', 'username avatar')
            .populate({
                path: 'conversation',
                populate: {
                    path: 'lastMessage',
                    select: 'content type createdAt sender'
                }
            })
            .sort({ updatedAt: -1 });

        res.json(groups);
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Get public groups
router.get('/public', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, search } = req.query;

        const query = { type: 'public' };
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        const groups = await Group.find(query)
            .populate('admin', 'username avatar')
            .select('name description avatar type members admin createdAt')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const total = await Group.countDocuments(query);

        res.json({
            groups,
            total,
            page: parseInt(page),
            pages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Get public groups error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Get group details
router.get('/:groupId', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId)
            .populate('admin', 'username avatar')
            .populate('members.user', 'username avatar')
            .populate('moderators', 'username avatar')
            .populate('pendingRequests.user', 'username avatar');

        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        // Check if user is a member for private groups
        if (group.type === 'private' && !group.isMember(userId)) {
            return res.status(403).json({ msg: 'Not authorized to view this group' });
        }

        res.json(group);
    } catch (error) {
        console.error('Get group error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Update group info
router.put('/:groupId', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { name, description, type, settings } = req.body;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.canEditInfo(userId)) {
            return res.status(403).json({ msg: 'Not authorized to edit group info' });
        }

        if (name) group.name = name.trim();
        if (description !== undefined) group.description = description.trim();
        if (type && group.isAdmin(userId)) {
            group.type = type;
            if (type === 'public' && !group.inviteCode) {
                group.inviteCode = crypto.randomBytes(8).toString('hex');
            }
        }
        if (settings && group.isAdmin(userId)) {
            group.settings = { ...group.settings, ...settings };
        }

        await group.save();
        await group.populate('admin', 'username avatar');
        await group.populate('members.user', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            io.to(`group-${groupId}`).emit('group-updated', { group });
        }

        res.json(group);
    } catch (error) {
        console.error('Update group error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Upload group avatar
router.post('/:groupId/avatar', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { fileName, fileType } = req.body;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.canEditInfo(userId)) {
            return res.status(403).json({ msg: 'Not authorized to edit group info' });
        }

        if (!fileType.startsWith('image/')) {
            return res.status(400).json({ msg: 'Only images are allowed' });
        }

        const key = `groups/${groupId}/avatar_${Date.now()}_${fileName}`;
        const uploadUrl = await s3.getSignedUrlPromise('putObject', {
            Bucket: process.env.WASABI_BUCKET,
            Key: key,
            Expires: 300,
            ContentType: fileType,
        });

        res.json({ uploadUrl, key });
    } catch (error) {
        console.error('Upload avatar error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Confirm avatar upload
router.put('/:groupId/avatar/confirm', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { key } = req.body;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group || !group.canEditInfo(userId)) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        group.avatar = key;
        await group.save();

        res.json({ msg: 'Avatar updated successfully', group });
    } catch (error) {
        console.error('Confirm avatar error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Add members to group
router.post('/:groupId/members', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { members } = req.body;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        if (!Array.isArray(members) || members.length === 0) {
            return res.status(400).json({ msg: 'Members array is required' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.isModerator(userId)) {
            return res.status(403).json({ msg: 'Only admins/moderators can add members' });
        }

        const addedMembers = [];
        for (const memberId of members) {
            if (!group.isMember(memberId)) {
                group.addMember(memberId);
                addedMembers.push(memberId);

                // Add to conversation
                const conversation = await Conversation.findById(group.conversation);
                if (conversation && !conversation.participants.includes(memberId)) {
                    conversation.participants.push(memberId);
                    await conversation.save();
                }
            }
        }

        await group.save();
        await group.populate('members.user', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            addedMembers.forEach(memberId => {
                io.to(`user-${memberId}`).emit('added-to-group', {
                    group,
                    addedBy: userId
                });
            });
            io.to(`group-${groupId}`).emit('members-added', {
                group,
                addedMembers
            });
        }

        res.json(group);
    } catch (error) {
        console.error('Add members error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Remove member from group
router.delete('/:groupId/members/:memberId', authMiddleware, async (req, res) => {
    try {
        const { groupId, memberId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId) || !mongoose.Types.ObjectId.isValid(memberId)) {
            return res.status(400).json({ msg: 'Invalid ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        // Check permissions: admin/moderators can remove anyone, members can only remove themselves
        const canRemove = group.isModerator(userId) || userId === memberId;
        if (!canRemove) {
            return res.status(403).json({ msg: 'Not authorized to remove this member' });
        }

        // Prevent removing the admin
        if (group.isAdmin(memberId)) {
            return res.status(400).json({ msg: 'Cannot remove the group admin' });
        }

        group.removeMember(memberId);
        await group.save();

        // Remove from conversation
        const conversation = await Conversation.findById(group.conversation);
        if (conversation) {
            conversation.participants = conversation.participants.filter(
                p => p.toString() !== memberId
            );
            await conversation.save();
        }

        const io = req.app.get('io');
        if (io) {
            io.to(`user-${memberId}`).emit('removed-from-group', {
                groupId,
                removedBy: userId
            });
            io.to(`group-${groupId}`).emit('member-removed', {
                groupId,
                memberId,
                removedBy: userId
            });
        }

        res.json({ msg: 'Member removed successfully' });
    } catch (error) {
        console.error('Remove member error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Promote member to moderator
router.post('/:groupId/members/:memberId/promote', authMiddleware, async (req, res) => {
    try {
        const { groupId, memberId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId) || !mongoose.Types.ObjectId.isValid(memberId)) {
            return res.status(400).json({ msg: 'Invalid ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.isAdmin(userId)) {
            return res.status(403).json({ msg: 'Only admin can promote members' });
        }

        if (!group.isMember(memberId)) {
            return res.status(400).json({ msg: 'User is not a member of this group' });
        }

        group.promoteMember(memberId);
        await group.save();
        await group.populate('members.user', 'username avatar');
        await group.populate('moderators', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            io.to(`user-${memberId}`).emit('promoted-to-moderator', { groupId });
            io.to(`group-${groupId}`).emit('member-promoted', {
                groupId,
                memberId
            });
        }

        res.json(group);
    } catch (error) {
        console.error('Promote member error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Demote moderator
router.post('/:groupId/members/:memberId/demote', authMiddleware, async (req, res) => {
    try {
        const { groupId, memberId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId) || !mongoose.Types.ObjectId.isValid(memberId)) {
            return res.status(400).json({ msg: 'Invalid ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.isAdmin(userId)) {
            return res.status(403).json({ msg: 'Only admin can demote moderators' });
        }

        group.demoteMember(memberId);
        await group.save();
        await group.populate('members.user', 'username avatar');
        await group.populate('moderators', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            io.to(`user-${memberId}`).emit('demoted-from-moderator', { groupId });
            io.to(`group-${groupId}`).emit('member-demoted', {
                groupId,
                memberId
            });
        }

        res.json(group);
    } catch (error) {
        console.error('Demote member error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Join public group
router.post('/:groupId/join', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (group.type !== 'public') {
            return res.status(400).json({ msg: 'Cannot join private group without invitation' });
        }

        if (group.isMember(userId)) {
            return res.status(400).json({ msg: 'Already a member of this group' });
        }

        if (group.settings.requireApprovalToJoin) {
            // Add to pending requests
            if (!group.pendingRequests.some(r => r.user.toString() === userId)) {
                group.pendingRequests.push({ user: userId, requestedAt: new Date() });
                await group.save();

                const io = req.app.get('io');
                if (io) {
                    io.to(`user-${group.admin}`).emit('group-join-request', {
                        groupId,
                        userId
                    });
                }

                return res.json({ msg: 'Join request sent. Waiting for approval.' });
            }
            return res.status(400).json({ msg: 'Join request already sent' });
        }

        // Join immediately
        group.addMember(userId);
        await group.save();

        // Add to conversation
        const conversation = await Conversation.findById(group.conversation);
        if (conversation && !conversation.participants.includes(userId)) {
            conversation.participants.push(userId);
            await conversation.save();
        }

        await group.populate('members.user', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            io.to(`group-${groupId}`).emit('member-joined', {
                groupId,
                userId
            });
        }

        res.json(group);
    } catch (error) {
        console.error('Join group error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Approve join request
router.post('/:groupId/requests/:userId/approve', authMiddleware, async (req, res) => {
    try {
        const { groupId, userId: requestUserId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId) || !mongoose.Types.ObjectId.isValid(requestUserId)) {
            return res.status(400).json({ msg: 'Invalid ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.isModerator(userId)) {
            return res.status(403).json({ msg: 'Only admins/moderators can approve requests' });
        }

        // Remove from pending requests
        group.pendingRequests = group.pendingRequests.filter(
            r => r.user.toString() !== requestUserId
        );

        // Add as member
        group.addMember(requestUserId);
        await group.save();

        // Add to conversation
        const conversation = await Conversation.findById(group.conversation);
        if (conversation && !conversation.participants.includes(requestUserId)) {
            conversation.participants.push(requestUserId);
            await conversation.save();
        }

        const io = req.app.get('io');
        if (io) {
            io.to(`user-${requestUserId}`).emit('group-request-approved', {
                groupId,
                approvedBy: userId
            });
        }

        res.json({ msg: 'Request approved successfully' });
    } catch (error) {
        console.error('Approve request error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Reject join request
router.post('/:groupId/requests/:userId/reject', authMiddleware, async (req, res) => {
    try {
        const { groupId, userId: requestUserId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId) || !mongoose.Types.ObjectId.isValid(requestUserId)) {
            return res.status(400).json({ msg: 'Invalid ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.isModerator(userId)) {
            return res.status(403).json({ msg: 'Only admins/moderators can reject requests' });
        }

        group.pendingRequests = group.pendingRequests.filter(
            r => r.user.toString() !== requestUserId
        );
        await group.save();

        const io = req.app.get('io');
        if (io) {
            io.to(`user-${requestUserId}`).emit('group-request-rejected', {
                groupId,
                rejectedBy: userId
            });
        }

        res.json({ msg: 'Request rejected successfully' });
    } catch (error) {
        console.error('Reject request error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Join group by invite code
router.post('/join-by-code', authMiddleware, async (req, res) => {
    try {
        const { inviteCode } = req.body;
        const userId = req.userId;

        if (!inviteCode) {
            return res.status(400).json({ msg: 'Invite code is required' });
        }

        const group = await Group.findOne({ inviteCode });
        if (!group) {
            return res.status(404).json({ msg: 'Invalid invite code' });
        }

        if (group.isMember(userId)) {
            return res.status(400).json({ msg: 'Already a member of this group' });
        }

        group.addMember(userId);
        await group.save();

        // Add to conversation
        const conversation = await Conversation.findById(group.conversation);
        if (conversation && !conversation.participants.includes(userId)) {
            conversation.participants.push(userId);
            await conversation.save();
        }

        await group.populate('members.user', 'username avatar');
        await group.populate('admin', 'username avatar');

        const io = req.app.get('io');
        if (io) {
            io.to(`group-${group._id}`).emit('member-joined', {
                groupId: group._id,
                userId
            });
        }

        res.json(group);
    } catch (error) {
        console.error('Join by code error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Delete group (admin only)
router.delete('/:groupId', authMiddleware, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(groupId)) {
            return res.status(400).json({ msg: 'Invalid group ID' });
        }

        const group = await Group.findById(groupId);
        if (!group) {
            return res.status(404).json({ msg: 'Group not found' });
        }

        if (!group.isAdmin(userId)) {
            return res.status(403).json({ msg: 'Only admin can delete the group' });
        }

        // Delete all messages in the group
        await Message.deleteMany({ conversation: group.conversation });

        // Delete the conversation
        await Conversation.findByIdAndDelete(group.conversation);

        // Delete the group
        await group.deleteOne();

        const io = req.app.get('io');
        if (io) {
            io.to(`group-${groupId}`).emit('group-deleted', { groupId });
        }

        res.json({ msg: 'Group deleted successfully' });
    } catch (error) {
        console.error('Delete group error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

export default router;