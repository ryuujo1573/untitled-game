class Time {
  // Static properties
  static before: number = 0;
  static now: number = 0;
  static deltaTime: number = Time.now - Time.before;
  static time: number = 0;

  /**
   * Normalised time-of-day in [0, 1).
   *   0.00 = midnight  0.25 = sunrise  0.50 = noon  0.75 = sunset
   * Starts at sunrise (0.25) so the world is immediately lit.
   */
  static worldTime: number = 0.25;

  /** Real-world seconds per full in-game day. */
  static readonly DAY_DURATION_SECONDS = 120;

  // Static methods
  static CalculateTimeVariables(): void {
    // Update the current time in seconds
    Time.now = performance.now() * 0.001;

    // Calculate the time difference between now and before
    Time.deltaTime = Time.now - Time.before;

    // Accumulate the total elapsed time
    Time.time = Time.time + Time.deltaTime;

    // Update before time to the current time for the next cycle
    Time.before = Time.now;

    // Advance normalised day time, wrapping at 1.
    Time.worldTime =
      (Time.worldTime +
        Time.deltaTime / Time.DAY_DURATION_SECONDS) %
      1;
  }

  // Static method Example for static classes
  static GetFPS(): number {
    return 1 / Time.deltaTime;
  }

  static getWorldTime(): number {
    return Time.worldTime;
  }

  static setWorldTime(value: number): void {
    Time.worldTime = ((value % 1) + 1) % 1;
  }

  // Instance method Example for static classes
  instanceMethod(): void {
    console.log(Time.CalculateTimeVariables()); // Accessing static property
    Time.CalculateTimeVariables(); // Calling static method
  }
}

/* Example of calling an instance method of a "static" class
// Create an instance of the class
const timeInstance = new Time();

// Call the instance method
timeInstance.instanceMethod();
*/

export default Time;
