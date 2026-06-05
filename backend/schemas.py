from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

# --- Token Schemas ---
class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None
    user_id: Optional[int] = None

# --- User Schemas ---
class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=4)

class UserResponse(BaseModel):
    id: int
    username: str
    elo_rating: int
    total_wins: int
    total_matches: int

    class Config:
        from_attributes = True

# --- Question Schemas ---
class QuestionResponse(BaseModel):
    id: int
    leetcode_id: str
    title: str
    striver_topic: str
    difficulty: str
    url: str

    class Config:
        from_attributes = True

# --- Match Schemas ---
class MatchCreate(BaseModel):
    striver_topic: str

class MatchResponse(BaseModel):
    id: int
    host_id: int
    host: UserResponse
    guest_id: Optional[int] = None
    guest: Optional[UserResponse] = None
    question_id: Optional[int] = None
    question: Optional[QuestionResponse] = None
    winner_id: Optional[int] = None
    winner: Optional[UserResponse] = None
    striver_topic: str
    duration_seconds: Optional[int] = None
    status: str
    created_at: datetime

    class Config:
        from_attributes = True

# --- Leaderboard Schema ---
class LeaderboardResponse(BaseModel):
    users: List[UserResponse]
