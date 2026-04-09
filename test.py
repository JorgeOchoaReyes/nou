import numpy as np
def create_wave_function(num_states):
    # Create an array to store the wave function coefficients
    wave_function = np.zeros((num_states), dtype=complex)
    # Set the initial state (|0\rangle)
    wave_function[0] = 1.0
    return wave_function