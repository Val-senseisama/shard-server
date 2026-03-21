export const Validate = {
    email: (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    URL: (url: string): boolean => /^(ftp|http|https):\/\/[^ "]+$/.test(url),
    phone: (phone: string): boolean => /^[0-9]+$/.test(phone),
    integer: (value: any): boolean => Number.isInteger(value),
    positiveInteger: (value: any): boolean => Number.isInteger(value) && value >= 0,
    float: (value: any): boolean => Number.isFinite(value),
    string: (value: any): boolean => typeof value === 'string' && value.trim() !== '',
    array: (value: any): boolean => Array.isArray(value) && value.length > 0,
    object: (value: any): boolean => typeof value === 'object' && value !== null && Object.keys(value).length > 0,
    ISODate: (dateString: string): boolean => !isNaN(Date.parse(dateString)) && new Date(dateString).toISOString() === dateString,
    date: (dateString: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(dateString) && !isNaN(new Date(dateString).getTime()),
    time: (time: string): boolean => /^([01]\d|2[0-3]):([0-5]\d)$/.test(time),
    datetime: (dateString: string): boolean => !isNaN(Date.parse(dateString)) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateString),
    formatPhone: (phone: string): string => {
        let inputString = phone.split(' ').join('')
            .split('+').join('')
            .split('-').join('')
            .split('(').join('')
            .split(')').join('');
        if (inputString.startsWith('009')) {
            return inputString.slice(3);
        } else if (inputString.startsWith('0')) {
            return '234' + inputString.slice(1);
        } else {
            return inputString;
        }
    },
};
