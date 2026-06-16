import mongoose, { Schema, Document } from 'mongoose';

export interface INotebook extends Document {
    title: string;
    createUser: string;
    createdAt: Date;
    updatedAt: Date;
}
