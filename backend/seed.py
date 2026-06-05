from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from backend.database import Base, DATABASE_URL
from backend.models import Question

def seed_database():
    print(f"Connecting to database to seed questions...")
    engine = create_engine(DATABASE_URL)
    Base.metadata.create_all(bind=engine)
    
    Session = sessionmaker(bind=engine)
    session = Session()

    # Define Striver's DSA Sheet Questions
    questions_data = [
        # Arrays
        {
            "leetcode_id": "1",
            "title": "Two Sum",
            "striver_topic": "Arrays",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/two-sum/"
        },
        {
            "leetcode_id": "121",
            "title": "Best Time to Buy and Sell Stock",
            "striver_topic": "Arrays",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/best-time-to-buy-and-sell-stock/"
        },
        {
            "leetcode_id": "56",
            "title": "Merge Intervals",
            "striver_topic": "Arrays",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/merge-intervals/"
        },
        {
            "leetcode_id": "31",
            "title": "Next Permutation",
            "striver_topic": "Arrays",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/next-permutation/"
        },
        {
            "leetcode_id": "75",
            "title": "Sort Colors",
            "striver_topic": "Arrays",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/sort-colors/"
        },
        # Linked List
        {
            "leetcode_id": "206",
            "title": "Reverse Linked List",
            "striver_topic": "Linked List",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/reverse-linked-list/"
        },
        {
            "leetcode_id": "21",
            "title": "Merge Two Sorted Lists",
            "striver_topic": "Linked List",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/merge-two-sorted-lists/"
        },
        {
            "leetcode_id": "19",
            "title": "Remove Nth Node From End of List",
            "striver_topic": "Linked List",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/remove-nth-node-from-end-of-list/"
        },
        {
            "leetcode_id": "141",
            "title": "Linked List Cycle",
            "striver_topic": "Linked List",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/linked-list-cycle/"
        },
        # Recursion
        {
            "leetcode_id": "78",
            "title": "Subsets",
            "striver_topic": "Recursion",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/subsets/"
        },
        {
            "leetcode_id": "46",
            "title": "Permutations",
            "striver_topic": "Recursion",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/permutations/"
        },
        {
            "leetcode_id": "39",
            "title": "Combination Sum",
            "striver_topic": "Recursion",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/combination-sum/"
        },
        {
            "leetcode_id": "51",
            "title": "N-Queens",
            "striver_topic": "Recursion",
            "difficulty": "Hard",
            "url": "https://leetcode.com/problems/n-queens/"
        },
        # Binary Search
        {
            "leetcode_id": "704",
            "title": "Binary Search",
            "striver_topic": "Binary Search",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/binary-search/"
        },
        {
            "leetcode_id": "33",
            "title": "Search in Rotated Sorted Array",
            "striver_topic": "Binary Search",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/search-in-rotated-sorted-array/"
        },
        {
            "leetcode_id": "540",
            "title": "Single Element in a Sorted Array",
            "striver_topic": "Binary Search",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/single-element-in-a-sorted-array/"
        },
        {
            "leetcode_id": "4",
            "title": "Median of Two Sorted Arrays",
            "striver_topic": "Binary Search",
            "difficulty": "Hard",
            "url": "https://leetcode.com/problems/median-of-two-sorted-arrays/"
        },
        # Dynamic Programming
        {
            "leetcode_id": "70",
            "title": "Climbing Stairs",
            "striver_topic": "Dynamic Programming",
            "difficulty": "Easy",
            "url": "https://leetcode.com/problems/climbing-stairs/"
        },
        {
            "leetcode_id": "1143",
            "title": "Longest Common Subsequence",
            "striver_topic": "Dynamic Programming",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/longest-common-subsequence/"
        },
        {
            "leetcode_id": "62",
            "title": "Unique Paths",
            "striver_topic": "Dynamic Programming",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/unique-paths/"
        },
        {
            "leetcode_id": "300",
            "title": "Longest Increasing Subsequence",
            "striver_topic": "Dynamic Programming",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/longest-increasing-subsequence/"
        },
        {
            "leetcode_id": "72",
            "title": "Edit Distance",
            "striver_topic": "Dynamic Programming",
            "difficulty": "Hard",
            "url": "https://leetcode.com/problems/edit-distance/"
        },
        # Graphs
        {
            "leetcode_id": "133",
            "title": "Clone Graph",
            "striver_topic": "Graphs",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/clone-graph/"
        },
        {
            "leetcode_id": "207",
            "title": "Course Schedule",
            "striver_topic": "Graphs",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/course-schedule/"
        },
        {
            "leetcode_id": "200",
            "title": "Number of Islands",
            "striver_topic": "Graphs",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/number-of-islands/"
        },
        {
            "leetcode_id": "785",
            "title": "Is Graph Bipartite?",
            "striver_topic": "Graphs",
            "difficulty": "Medium",
            "url": "https://leetcode.com/problems/is-graph-bipartite/"
        }
    ]

    added_count = 0
    for q_info in questions_data:
        # Check if question already exists by leetcode_id
        exists = session.query(Question).filter(Question.leetcode_id == q_info["leetcode_id"]).first()
        if not exists:
            new_q = Question(**q_info)
            session.add(new_q)
            added_count += 1
            
    session.commit()
    print(f"Successfully seeded {added_count} new questions (total processed: {len(questions_data)}).")
    session.close()

if __name__ == "__main__":
    seed_database()
