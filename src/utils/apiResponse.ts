class ApiResponse<T> {
    public readonly timestamp: Date;
    public count: number | null;

    constructor(
        public success: boolean,
        public data: T | null = null,
        public message: string = '',
    ) {
        this.success = success;
        this.data = data;
        this.message = message;
        this.timestamp = new Date(); // 添加时间戳
        this.count = Array.isArray(this.data) ? this.data.length : null;
    }

    static success<T>(data: T, message: string = ''): ApiResponse<T> {
        return new ApiResponse<T>(true, data, message);
    }

    static error<T>(message: string, data?: T | null): ApiResponse<T> {
        return new ApiResponse<T>(false, data ?? null, message);
    }
}
export default ApiResponse;
