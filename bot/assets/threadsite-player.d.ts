/** Private credential: never publish it, or use a public player ID as a credential. */
export declare function getPlayerIdentity(game: string, supplied?: string): {
    token: string | null;
    persistent: boolean;
};
