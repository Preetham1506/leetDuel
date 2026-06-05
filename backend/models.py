from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, text
from sqlalchemy.orm import relationship
from datetime import datetime
from backend.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    elo_rating = Column(Integer, default=1200, nullable=False)
    total_wins = Column(Integer, default=0, nullable=False)
    total_matches = Column(Integer, default=0, nullable=False)

    # Relationships
    hosted_matches = relationship("Match", foreign_keys="Match.host_id", back_populates="host")
    guest_matches = relationship("Match", foreign_keys="Match.guest_id", back_populates="guest")
    won_matches = relationship("Match", foreign_keys="Match.winner_id", back_populates="winner")

class Question(Base):
    __tablename__ = "questions"

    id = Column(Integer, primary_key=True, index=True)
    leetcode_id = Column(String(50), unique=True, index=True, nullable=False)
    title = Column(String(255), nullable=False)
    striver_topic = Column(String(255), index=True, nullable=False)
    difficulty = Column(String(50), nullable=False) # Easy, Medium, Hard
    url = Column(String(512), nullable=False)

    # Relationships
    matches = relationship("Match", back_populates="question")

class Match(Base):
    __tablename__ = "matches"

    id = Column(Integer, primary_key=True, index=True)
    host_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    guest_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=True)
    winner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    striver_topic = Column(String(255), nullable=False)
    duration_seconds = Column(Integer, nullable=True)
    status = Column(String(50), default="PENDING", nullable=False) # PENDING, ACTIVE, COMPLETED, FORFEITED, ABANDONED
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    host = relationship("User", foreign_keys=[host_id], back_populates="hosted_matches")
    guest = relationship("User", foreign_keys=[guest_id], back_populates="guest_matches")
    question = relationship("Question", back_populates="matches")
    winner = relationship("User", foreign_keys=[winner_id], back_populates="won_matches")
