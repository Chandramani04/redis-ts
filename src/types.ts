// this file will export interfaces and types for all the db schemas and other types used in the project

// user model type
export interface IUser {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}
