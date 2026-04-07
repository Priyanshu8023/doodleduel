let correctSound: HTMLAudioElement | null = null;
let roundStartSound: HTMLAudioElement | null = null;
let tickSound: HTMLAudioElement | null = null;
let roundEndSound: HTMLAudioElement | null = null;

// Initialize audio objects lazily and ensure window is defined (for server-side rendering safety)
const getAudio = (url: string) => {
    if (typeof window === "undefined") return null;
    return new Audio(url);
};

export const playCorrectGuessSound = () => {
    if (typeof window === "undefined") return;
    if (!correctSound) correctSound = getAudio("/sounds/playerGuessed.ogg");
    
    if (correctSound) {
        correctSound.currentTime = 0;
        correctSound.play().catch(e => console.error("Audio block:", e));
    }
};

export const playRoundStartSound = () => {
    if (typeof window === "undefined") return;
    if (!roundStartSound) roundStartSound = getAudio("/sounds/roundStart.ogg");
    
    if (roundStartSound) {
        roundStartSound.currentTime = 0;
        roundStartSound.play().catch(e => console.error("Audio block:", e));
    }
};

export const playTickSound = () => {
    if (typeof window === "undefined") return;
    if (!tickSound) tickSound = getAudio("/sounds/tick.ogg");
    
    if (tickSound) {
        tickSound.currentTime = 0;
        tickSound.play().catch(e => console.error("Audio block:", e));
    }
};

export const playRoundEndSound = () => {
    if (typeof window === "undefined") return;
    if (!roundEndSound) roundEndSound = getAudio("/sounds/roundEndFailure.ogg");
    
    if (roundEndSound) {
        roundEndSound.currentTime = 0;
        roundEndSound.play().catch(e => console.error("Audio block:", e));
    }
};