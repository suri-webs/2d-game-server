import { Router } from 'express';
import { signup, login, getMe, updateStats, getLeaderboard } from './authController';
import { authMiddleware } from './authMiddleware';

const router = Router();

router.post('/signup', signup as any);
router.post('/login', login as any);
router.get('/me', authMiddleware as any, getMe as any);
router.post('/stats', authMiddleware as any, updateStats as any);
router.get('/leaderboard', getLeaderboard as any);

export default router;
