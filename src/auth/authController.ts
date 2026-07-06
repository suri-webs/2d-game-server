import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { hashPassword, verifyPassword } from './hash';
import { getJwtSecret, AuthenticatedRequest } from './authMiddleware';

export async function signup(req: Request, res: Response) {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { email }
        ]
      }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already in use.' });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        coins: 0,
        levelsCompleted: 0
      }
    });

    // Sign JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        coins: user.coins,
        levelsCompleted: user.levelsCompleted
      }
    });
  } catch (error: any) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const { loginId, password } = req.body; // loginId can be username or email

    if (!loginId || !password) {
      return res.status(400).json({ error: 'Username/email and password are required.' });
    }

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: loginId },
          { email: loginId }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    // Check password
    const isPasswordValid = await verifyPassword(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    // Sign JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        coins: user.coins,
        levelsCompleted: user.levelsCompleted
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
}

export async function getMe(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        coins: user.coins,
        levelsCompleted: user.levelsCompleted
      }
    });
  } catch (error) {
    console.error('getMe error:', error);
    res.status(500).json({ error: 'Internal server error fetching user.' });
  }
}

export async function updateStats(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const { coins, levelsCompleted } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        coins: typeof coins === 'number' ? Math.max(user.coins, coins) : user.coins,
        levelsCompleted: typeof levelsCompleted === 'number' ? Math.max(user.levelsCompleted, levelsCompleted) : user.levelsCompleted
      }
    });

    res.status(200).json({
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        coins: updatedUser.coins,
        levelsCompleted: updatedUser.levelsCompleted
      }
    });
  } catch (error) {
    console.error('Update stats error:', error);
    res.status(500).json({ error: 'Internal server error updating stats.' });
  }
}

export async function getLeaderboard(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      select: {
        username: true,
        coins: true,
        levelsCompleted: true
      },
      orderBy: [
        { coins: 'desc' },
        { levelsCompleted: 'desc' }
      ],
      take: 10
    });

    res.status(200).json({ leaderboard: users });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: 'Internal server error fetching leaderboard.' });
  }
}
