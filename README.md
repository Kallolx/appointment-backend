# AppointPro Backend

This is the backend server for the AppointPro application, providing authentication and user management functionality.

## Setup Instructions

### Prerequisites

- Node.js (v14 or higher)
- MySQL (v5.7 or higher)

### Database Setup

1. Create a MySQL database named `appointpro`
2. The tables will be automatically created when the server starts

### Installation

1. Install dependencies:
   ```
   npm install
   ```

2. Configure environment variables:
   - Rename `.env.example` to `.env` (or create a new `.env` file)
   - Update the database credentials in the `.env` file

3. Start the server:
   ```
   npm start
   ```
   
   For development with auto-reload:
   ```
   npm run dev
   ```

## API Endpoints

### Authentication

- `POST /api/auth/check-phone` - Check if a phone number exists
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login a user

### User

- `GET /api/user/profile` - Get user profile (protected route)

## Authentication

The API uses JWT (JSON Web Token) for authentication. Protected routes require an Authorization header with a Bearer token:

```
Authorization: Bearer <token>
```